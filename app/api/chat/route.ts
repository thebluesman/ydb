export const runtime = 'nodejs'

import { prisma, executeReadonlyQuery } from '@/lib/prisma'
import { getLlmConfig } from '@/lib/llm-config'
import {
  buildKnowledgeBlock,
  buildNarrationSystemPrompt,
  loadKnowledgeSnippets,
  NARRATION_KNOWLEDGE_TIER,
} from '@/lib/chatKnowledge'
import {
  isNoDataResult,
  noDataMessage,
  nonAnswerFrame,
  nonAnswerResponse,
} from '@/lib/chatNonAnswer'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'

// Thrown when Ollama is unreachable or errors during SQL generation, so the
// caller can distinguish a transport failure (503) from a bad query (422).
class OllamaUnavailable extends Error {}

// Generate a SQL statement from a prompt via Ollama (non-streaming, temp 0).
// Cleans markdown fences and quotes bare Transaction references. Shared by the
// initial generation and the one-shot repair retry.
// `system` is passed in rather than read off a module const because it now
// carries the current date (lib/chatSqlPrompt.ts) — it has to be built per
// request, and the repair round-trip must reuse the same one the first attempt
// saw or the model gets shown two different "today"s in one turn.
async function generateSql(
  ollamaUrl: string, model: string, system: string, prompt: string, signal: AbortSignal,
): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        system,
        prompt,
        stream: false,
        options: { temperature: 0, num_ctx: SQL_NUM_CTX },
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

// Same reasoning for the SQL-generation call (generateSql), which until now set
// no num_ctx at all and inherited whatever the server/model default happened to
// be. Truncation is arguably worse here than in narration: the front of this
// prompt is buildSqlSystemPrompt() — the schema, the reserved-word rule, the
// integer-cents rule — so a silent front-truncation doesn't degrade phrasing,
// it produces confidently wrong SQL against a half-known schema.
//
// Measured on Ollama 0.30.6 (2026-07-29) via prompt_eval_count, with
// num_predict 1. qwen2.5:32b and qwen2.5-coder:14b share a tokenizer and
// returned identical counts on every case below:
//   SQL system prompt alone                                   791 tokens
//   typical (no history, one-line question)                   800
//   worst history (8 × 2,000-char prose turns)              4,007
//   worst history + repair round-trip (failed SQL + error)  4,130  ← today's max
// Filler-character history tokenizes cheaper (2,978 for the same case), so the
// prose figure is the real ceiling; HISTORY_MESSAGE_CAP × HISTORY_CHAR_CAP is
// what bounds it.
//
// Ticket 2 (ADR-0008) injects the stored category/account-name vocabulary into
// this same prompt, so the value is sized for that now rather than bumped
// again next ticket. Measured with the real dev-DB vocabulary (46 distinct
// Transaction.category values — emoji-prefixed, so unusually token-expensive —
// and 10 Account.name values) rendered as a closed list with its
// only-use-a-literal-from-this-list rule:
//   vocabulary block alone                                    423 tokens
//   worst case above + vocabulary block                     4,539
// And with the block scaled up to model ADR-0008's "cap it, escalate rather
// than truncate" requirement, so the cap can be set generously:
//   150 categories / 30 accounts → block 1,434, worst case  5,550
//   300 categories / 50 accounts → block 2,863, worst case  6,979
//
// 16384 clears even the 300-category projection with >2× headroom over today's
// actual worst case, and leaves ample room for the generated SQL (a few hundred
// tokens at most; LIMIT 200 caps the query, not the response text).
//
// Why the same value as NARRATION_NUM_CTX rather than a tighter 8192: Ollama
// keys its loaded runner on the request options, so a chat turn that asks for
// 8192 then 16384 unloads and reloads the model between the two calls.
// Measured on this install: repeating a num_ctx costs 0.15s load_duration,
// changing it costs ~5s — twice per turn, for no benefit. They are kept as two
// named constants because they bound two different prompts and will drift
// apart if either grows; if they do diverge, the reload cost is the trade to
// price in.
//
// Same model caveat as NARRATION_NUM_CTX: validated only against the two
// recommended chat models (qwen2.5:32b, qwen2.5-coder:14b, both ≥32k native
// context) per ROLE_META in lib/llm-models.ts. A fixed value is preferred over
// querying each model's context window because a loud Ollama error on an
// unsupported num_ctx is a safe failure mode; silent truncation is not.
const SQL_NUM_CTX = 16_384

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

  // Resolved once per request and reused by the repair round-trip, so both
  // calls in a turn agree on what "today" is even across a midnight boundary.
  const sqlSystemPrompt = buildSqlSystemPrompt()

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
    sql = await generateSql(ollamaUrl, chatModel, sqlSystemPrompt, sqlPrompt, signal)
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
  //
  // A non-SELECT here is a refusal, not a crash: the pipeline worked and
  // couldn't produce a query it would stand behind (ADR-0014). Tickets 2-4
  // add their rejections alongside this one, same frame, different reason.
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    return nonAnswerResponse(nonAnswerFrame(
      'unsupported-shape',
      "I couldn't turn that into a single query I trust. The model returned something that isn't a " +
        'SELECT, so nothing was run. Rephrasing the question — one figure at a time — usually fixes it.',
      sql,
    ))
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
      repaired = await generateSql(ollamaUrl, chatModel, sqlSystemPrompt, repairPrompt, signal)
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

  // A clean run that matched nothing is a non-answer, and it never reaches
  // narration (ADR-0014). Narrating `[{"total": null}]` is what produced "you
  // spent nothing on groceries last month" — a wrong answer wearing a
  // confident sentence. This is the cheapest of the four reasons and the only
  // one wired live here; ADR-0008 will reuse it with the real category
  // vocabulary attached.
  if (isNoDataResult(rows)) {
    return nonAnswerResponse(nonAnswerFrame('no-data', noDataMessage(question), sql))
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
