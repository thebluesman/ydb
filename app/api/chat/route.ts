export const runtime = 'nodejs'

import { prisma, executeReadonlyQuery } from '@/lib/prisma'
import { getLlmConfig } from '@/lib/llm-config'
import {
  buildKnowledgeBlock,
  buildNarrationSystemPrompt,
  loadKnowledgeSnippets,
  NARRATION_KNOWLEDGE_TIER,
} from '@/lib/chatKnowledge'

// Thrown when Ollama is unreachable or errors during SQL generation, so the
// caller can distinguish a transport failure (503) from a bad query (422).
class OllamaUnavailable extends Error {}

// Generate a SQL statement from a prompt via Ollama (non-streaming, temp 0).
// Cleans markdown fences and quotes bare Transaction references. Shared by the
// initial generation and the one-shot repair retry.
async function generateSql(
  ollamaUrl: string, model: string, prompt: string, signal: AbortSignal,
): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        system: SQL_SYSTEM_PROMPT,
        prompt,
        stream: false,
        options: { temperature: 0 },
      }),
      signal,
    })
  } catch {
    throw new OllamaUnavailable(`Could not connect to Ollama at ${ollamaUrl}`)
  }
  if (!res.ok) throw new OllamaUnavailable(`Ollama returned ${res.status}`)

  const json = await res.json()
  const rawSql = (json.response as string ?? '').trim()
  let sql = rawSql.replace(/^```[\w]*\n?/i, '').replace(/\n?```$/i, '').trim()
  sql = sql.replace(/\bFROM\s+Transaction\b/gi, 'FROM "Transaction"')
  sql = sql.replace(/\bJOIN\s+Transaction\b/gi, 'JOIN "Transaction"')
  return sql
}

const SQL_SYSTEM_PROMPT = `You are a SQLite query generator. Output ONLY a single raw SQL SELECT statement (or WITH ... SELECT) -- no markdown, no explanation, no code fences, no backticks.

Schema (readable tables only):
  Account(id, name, accountType, currency, isActive, openingBalance, openingBalanceDate, creditLimit, createdAt, updatedAt)
  Transaction(id, date, amount, description, originalDescription, transactionType, category, accountId, status, notes,
              linkedTransferId, parentTransactionId, reimbursableFor, reimbursementTxId, transferCounterpartAccountId,
              rawSource, createdAt, updatedAt)
  Category(id, name, color)

Tables you MUST NOT query (access is blocked at the driver level): Setting, ChatSession, ChatMessage, Budget, VendorRule.
Avoid selecting from sqlite_master or any pragma_* function.

Rules:
- SQLite dialect only: use strftime('%Y-%m', date) for month grouping, NOT DATE_TRUNC.
- CRITICAL: "Transaction" is a reserved word in SQLite. Always wrap it in double quotes: "Transaction".
- Transaction.date is an ISO datetime string (e.g. '2024-03-15 00:00:00.000').
- Transaction.amount is an INTEGER number of cents. For user-facing sums, divide by 100.0.
- Transaction.transactionType: 'credit' | 'debit' | 'transfer'.
- Amount sign: negative = debit/out, positive = credit/in. Use transactionType for filtering by type.
- status values: 'review', 'committed', 'reconciled'. For financial queries prefer WHERE status IN ('committed','reconciled') unless the user asks otherwise.
- Split legs: when parentTransactionId IS NOT NULL the row is a leg; the parent is a placeholder that sums the legs. When aggregating spend, exclude parents (WHERE parentTransactionId IS NULL) OR include the legs instead, NOT both.
- Matched reimbursement pairs (reimbursementTxId IS NOT NULL on the expense side) net to zero. To compute true net spend, exclude the expense side AND the credit that appears as a reimbursement target. Example guard on the expense side: AND reimbursementTxId IS NULL. To also skip the paired credit: AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id).
- Always include LIMIT 200 at most.
- For joins use "Transaction".accountId = Account.id.

Examples:
Q: How many transactions do I have?
A: SELECT COUNT(*) AS total FROM "Transaction" WHERE status IN ('committed','reconciled')

Q: How much did I spend on groceries last month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = 'Groceries' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')

Q: What are my top 5 spending categories this year?
A: SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount < 0 AND parentTransactionId IS NULL AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled') GROUP BY category ORDER BY total ASC LIMIT 5

Q: What is my total income this month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount > 0 AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) AND status IN ('committed','reconciled')`

type HistoryMessage = { role: 'user' | 'assistant'; text: string }

// Cap on rows sent to the narration prompt. Larger result sets get truncated
// with a note so the model doesn't see a 200-row JSON blob (expensive tokens,
// noisy output).
const NARRATION_ROW_CAP = 20

// Keep the model prompt bounded: only the last few turns of context, and cap
// each message so a pasted wall of text can't blow out num_ctx.
const HISTORY_MESSAGE_CAP = 8
const HISTORY_CHAR_CAP = 2000

// Ollama can hang indefinitely on a stuck model; bound every call and forward
// the client's abort so navigating away cancels generation server-side too.
const OLLAMA_TIMEOUT_MS = 120_000

// Ollama silently truncates an over-length prompt from the FRONT — exactly
// where the injected knowledge block sits — so the context window has to be
// resolved rather than inherited.
//
// Measured on Ollama 0.30.6 / qwen2.5:32b (2026-07-29), via prompt_eval_count:
//   knowledge block alone (12 active P0 snippets)           922 tokens
//   typical prompt (one aggregate row): without 126, with  1,061
//   worst case (8 × 2,000-char history + 20 wide rows):
//                                     without 7,751, with  8,686
// The worst case was NOT truncated at this install's default — it evaluated
// all 8,686 tokens. But that default is a server-level setting
// (OLLAMA_CONTEXT_LENGTH / per-model auto-sizing) that this app neither owns
// nor can see, and a silent truncation would eat the knowledge block first and
// leave no error behind. So we pin it. 16384 clears the measured worst case
// with roughly 2× headroom for the generated response, and fits inside the
// recommended chat models' native context (qwen2.5:32b is 32k).
//
// This value is validated against the two recommended chat models only
// (qwen2.5:32b and qwen2.5-coder:14b, both ≥32k native context) — see
// ROLE_META in lib/llm-models.ts. The Advanced picker there allows any
// installed model, including smaller-context ones; a fixed 16384 was chosen
// over dynamically querying each model's context window because a loud
// Ollama error on an unsupported num_ctx is a safe failure mode, and this app
// has exactly one operator who chooses the model deliberately. If the
// picker's model set changes, or a smaller-context model becomes common, this
// assumption needs revisiting.
const NARRATION_NUM_CTX = 16_384
function ollamaSignal(clientSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MS)
  return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout
}

function trimHistory(history: unknown): HistoryMessage[] {
  if (!Array.isArray(history)) return []
  return (history as HistoryMessage[])
    .slice(-HISTORY_MESSAGE_CAP)
    .map((m) => ({ role: m.role, text: String(m.text ?? '').slice(0, HISTORY_CHAR_CAP) }))
}

export async function POST(request: Request) {
  const { question, history } = await request.json()

  if (!question || typeof question !== 'string') {
    return new Response(JSON.stringify({ type: 'error', message: 'question field required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const baseCurrencySetting = await prisma.setting.findFirst({ where: { key: 'baseCurrency' } })
  const baseCurrency = baseCurrencySetting?.value ?? 'USD'

  const { ollamaUrl, chatModel } = await getLlmConfig()
  const signal = ollamaSignal(request.signal)

  const trimmedHistory = trimHistory(history)

  // Build SQL prompt with prior conversation context so follow-up references resolve correctly
  const sqlPrompt = trimmedHistory.length > 0
    ? trimmedHistory
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n') + `\nUser: ${question}`
    : question

  // Phase 1: generate SQL (non-streaming). temperature 0 — SQL generation wants
  // determinism, not creativity.
  let sql: string
  try {
    sql = await generateSql(ollamaUrl, chatModel, sqlPrompt, signal)
  } catch (e) {
    const message = e instanceof OllamaUnavailable ? e.message : `Could not connect to Ollama at ${ollamaUrl}`
    return new Response(
      JSON.stringify({ type: 'error', message }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Accept both SELECT ... and WITH ... SELECT. The read-only driver is the
  // actual safety boundary; the guard is a cheap rejection of obvious
  // non-reads before we hit the DB.
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    return new Response(
      JSON.stringify({ type: 'error', message: 'Model did not return a SELECT or WITH statement. Try rephrasing your question.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Execute the SQL on a read-only connection to prevent mutations. On a SQLite
  // error, give the model exactly ONE repair round-trip (feed it the failed SQL
  // and the error) before surfacing the failure — models frequently mis-name a
  // column or forget a quote and fix it correctly when shown the message.
  let rows: unknown[]
  let dbTruncated = false
  try {
    const result = executeReadonlyQuery(sql)
    rows = result.rows
    dbTruncated = result.truncated
  } catch (err) {
    const firstMsg = err instanceof Error ? err.message : String(err)

    const repairPrompt =
      `${sqlPrompt}\n\nYou previously generated this SQLite query:\n${sql}\n\n` +
      `Executing it failed with this error:\n${firstMsg}\n\n` +
      `Return a corrected SQLite SELECT (or WITH ... SELECT) that fixes the error. Output only the SQL.`

    let repaired: string
    try {
      repaired = await generateSql(ollamaUrl, chatModel, repairPrompt, signal)
    } catch {
      // Repair round-trip couldn't reach the model — surface the original error.
      return new Response(
        JSON.stringify({ type: 'error', message: `SQL error: ${firstMsg}`, sql }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (!/^\s*(SELECT|WITH)\b/i.test(repaired)) {
      return new Response(
        JSON.stringify({ type: 'error', message: `SQL error: ${firstMsg}`, sql }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      const result = executeReadonlyQuery(repaired)
      rows = result.rows
      dbTruncated = result.truncated
      sql = repaired // the corrected query is what actually ran; report it
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2)
      return new Response(
        JSON.stringify({ type: 'error', message: `SQL error: ${msg2}`, sql: repaired }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }

  // Build conversation context for narration
  const priorContext = trimmedHistory.length > 0
    ? trimmedHistory
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n') + '\n\n'
    : ''

  // Cap narration input. 200 rows of JSON blows out the prompt token budget
  // and rarely improves the answer — the model can reason about an aggregate
  // result (a handful of rows) just as well. dbTruncated means the read-only
  // driver already cut the result at its hard row cap upstream.
  const narrationTruncated = rows.length > NARRATION_ROW_CAP
  const narrationRows = narrationTruncated ? rows.slice(0, NARRATION_ROW_CAP) : rows
  const truncationNote = (narrationTruncated || dbTruncated)
    ? `\n\nNote: query returned ${dbTruncated ? 'a large number of' : String(rows.length)} rows` +
      `${dbTruncated ? ' (capped by the server)' : ''}; only the first ${Math.min(NARRATION_ROW_CAP, rows.length)} are shown above.`
    : ''

  // Knowledge injection (ADR-0007): narration prompt only, never the SQL
  // prompt. Read fresh off disk each turn; the loader never throws, so a
  // missing or unreadable docs/knowledge/ just means no block.
  const knowledgeBlock = buildKnowledgeBlock(loadKnowledgeSnippets(NARRATION_KNOWLEDGE_TIER))

  // Phase 2: narration (streaming)
  let narrateRes: Response
  try {
    narrateRes = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        system: buildNarrationSystemPrompt(baseCurrency, knowledgeBlock),
        prompt: `${priorContext}User: ${question}\n\nData:\n${JSON.stringify(narrationRows, null, 2)}${truncationNote}`,
        stream: true,
        options: { num_ctx: NARRATION_NUM_CTX },
      }),
      signal: ollamaSignal(request.signal),
    })
  } catch {
    return new Response(
      JSON.stringify({ type: 'error', message: `Could not connect to Ollama at ${ollamaUrl}`, sql }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  if (!narrateRes.ok || !narrateRes.body) {
    return new Response(
      JSON.stringify({ type: 'error', message: `Ollama returned ${narrateRes.status}`, sql }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const narrateBody = narrateRes.body

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const emit = (obj: object) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'))

      emit({ type: 'sql', sql })

      const reader = narrateBody.getReader()
      const dec = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const chunk = JSON.parse(line)
              if (chunk.response) emit({ type: 'token', response: chunk.response })
            } catch { /* skip malformed */ }
          }
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}
