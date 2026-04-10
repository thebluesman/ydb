export const runtime = 'nodejs'

import { prisma } from '@/lib/prisma'

const SQL_SYSTEM_PROMPT = `You are a SQLite query generator. Output ONLY a single raw SQL SELECT statement -- no markdown, no explanation, no code fences, no backticks.

Schema:
  Account(id, name, accountType, currency, isActive, openingBalance, openingBalanceDate, creditLimit)
  Transaction(id, date, amount, description, transactionType, category, accountId, status, notes, linkedTransferId)
  Category(id, name, color)

Rules:
- SQLite dialect only: use strftime('%Y-%m', date) for month grouping, NOT DATE_TRUNC
- CRITICAL: "Transaction" is a reserved word in SQLite. Always wrap it in double quotes: "Transaction"
- Transaction.date is an ISO datetime string (e.g. '2024-03-15 00:00:00.000')
- Transaction.transactionType: 'credit' | 'debit' | 'transfer'
- Transaction.amount: negative = debit/out, positive = credit/in (use transactionType for filtering by type)
- status values: 'review', 'committed', 'reconciled' -- for financial queries prefer WHERE status IN ('committed','reconciled') unless the user asks otherwise
- Always include LIMIT 200 at most
- For joins use "Transaction".accountId = Account.id

Examples:
Q: How many transactions do I have?
A: SELECT COUNT(*) AS total FROM "Transaction" WHERE status IN ('committed','reconciled')

Q: How much did I spend on groceries last month?
A: SELECT SUM(amount) AS total FROM "Transaction" WHERE category = 'Groceries' AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')

Q: What are my top 5 spending categories this year?
A: SELECT category, SUM(amount) AS total FROM "Transaction" WHERE amount < 0 AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled') GROUP BY category ORDER BY total ASC LIMIT 5

Q: What is my total income this month?
A: SELECT SUM(amount) AS total FROM "Transaction" WHERE amount > 0 AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) AND status IN ('committed','reconciled')`

type HistoryMessage = { role: 'user' | 'assistant'; text: string }

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

  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434'
  const chatModel = process.env.CHAT_MODEL ?? 'gemma3:12b'

  // Build SQL prompt with prior conversation context so follow-up references resolve correctly
  const sqlPrompt = Array.isArray(history) && history.length > 0
    ? (history as HistoryMessage[])
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n') + `\nUser: ${question}`
    : question

  // Phase 1: generate SQL (non-streaming)
  let sqlGenRes: Response
  try {
    sqlGenRes = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        system: SQL_SYSTEM_PROMPT,
        prompt: sqlPrompt,
        stream: false,
      }),
    })
  } catch {
    return new Response(
      JSON.stringify({ type: 'error', message: `Could not connect to Ollama at ${ollamaUrl}` }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  if (!sqlGenRes.ok) {
    return new Response(
      JSON.stringify({ type: 'error', message: `Ollama returned ${sqlGenRes.status}` }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const sqlGenJson = await sqlGenRes.json()
  const rawSql = (sqlGenJson.response as string ?? '').trim()

  // Strip accidental markdown fences and ensure Transaction is quoted
  let sql = rawSql.replace(/^```[\w]*\n?/i, '').replace(/\n?```$/i, '').trim()
  // Safety net: quote bare Transaction references the model may have missed
  sql = sql.replace(/\bFROM\s+Transaction\b/gi, 'FROM "Transaction"')
  sql = sql.replace(/\bJOIN\s+Transaction\b/gi, 'JOIN "Transaction"')

  if (!sql.match(/^SELECT\b/i)) {
    return new Response(
      JSON.stringify({ type: 'error', message: 'Model did not return a SELECT statement. Try rephrasing your question.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Execute the SQL
  let rows: unknown[]
  try {
    const raw = await prisma.$queryRawUnsafe(sql)
    // $queryRawUnsafe returns COUNT(*) etc. as BigInt — convert to plain numbers
    rows = JSON.parse(JSON.stringify(raw, (_key, val) =>
      typeof val === 'bigint' ? Number(val) : val
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(
      JSON.stringify({ type: 'error', message: `SQL error: ${msg}`, sql }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Build conversation context for narration
  const priorContext = Array.isArray(history) && history.length > 0
    ? (history as HistoryMessage[])
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n') + '\n\n'
    : ''

  // Phase 2: narration (streaming)
  let narrateRes: Response
  try {
    narrateRes = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        system: `You are a helpful financial assistant. Answer the user's question in plain English using the data provided. Be concise and specific -- include actual numbers from the data. Always express monetary amounts in ${baseCurrency} without adding any other currency symbols or converting values.`,
        prompt: `${priorContext}User: ${question}\n\nData:\n${JSON.stringify(rows, null, 2)}`,
        stream: true,
      }),
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
