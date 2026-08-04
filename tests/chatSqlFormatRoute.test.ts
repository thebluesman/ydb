import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// [chat-perf]: SQL generation is now grammar-constrained via Ollama's `format`
// parameter to a `{"sql": "..."}` JSON envelope, same technique
// `app/api/ollama/route.ts`'s `EXTRACTION_FORMAT` already validated in this
// codebase, eliminating the markdown-fence-stripping hack for the common case.
//
// Backward compatibility is the point of this suite: a model or Ollama version
// that ignores `format` (or a version where the parameter shape has changed
// again — this API has before) must still work via the pre-format raw-text
// fallback, not hard-fail the turn.
//
// Same mocking pattern as tests/chatMoneyUnitsRoute.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', '🏠 Rent']
const ACCOUNTS = ['ADCB Current', 'Emirates NBD Savings']

let queryCalls: string[] = []
let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'AED' }) },
    transaction: { findMany: async () => CATEGORIES.map((category) => ({ category })) },
    account: { findMany: async () => ACCOUNTS.map((name) => ({ name })) },
  },
  executeReadonlyQuery: (sql: string) => {
    queryCalls.push(sql)
    const next = queryResults.shift()
    if (!next) return { rows: [{ total: 1234.56 }], truncated: false }
    return next()
  },
}))

vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: async () => ({
    ollamaUrl: 'http://ollama.test',
    sqlModel: 'qwen2.5:32b',
    narrationModel: 'qwen2.5:32b',
  }),
}))

const { POST } = await import('@/app/api/chat/route')

let sqlGenPayloads: Record<string, unknown>[] = []
let sqlReplies: string[] = []

function narrationStream(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ response: 'Answer.' }) + '\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

beforeEach(() => {
  queryCalls = []
  queryResults = []
  sqlGenPayloads = []
  sqlReplies = []

  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    if (payload.stream) return narrationStream()
    sqlGenPayloads.push(payload)
    return new Response(JSON.stringify({ response: sqlReplies.shift() ?? 'SELECT 1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ask(question: string): Promise<Response> {
  return POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  }))
}

async function frames(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text()
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

const PLAIN_SQL = `SELECT COUNT(*) AS total FROM "Transaction" WHERE parentTransactionId IS NULL`

describe('SQL generation requests the JSON-schema format', () => {
  it('sends a `format` constraint on the SQL-generation call', async () => {
    sqlReplies = [JSON.stringify({ sql: PLAIN_SQL })]
    await ask('How many transactions do I have?')

    // SQL generation, then Phase A verification (ADR-0025) — both non-streaming.
    expect(sqlGenPayloads).toHaveLength(2)
    expect(sqlGenPayloads[0].format).toEqual({
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    })
  })
})

describe('a JSON-enveloped response is unwrapped correctly', () => {
  it('extracts the sql field and runs it', async () => {
    sqlReplies = [JSON.stringify({ sql: PLAIN_SQL })]
    const res = await ask('How many transactions do I have?')

    expect(queryCalls).toEqual([PLAIN_SQL])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql: PLAIN_SQL })
  })

  it('handles escaped quotes and unicode inside the JSON string', async () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🛒 Groceries'`
    sqlReplies = [JSON.stringify({ sql })]
    const res = await ask('How much did I spend on groceries?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
  })

  it('still quotes a bare Transaction reference inside the unwrapped SQL', async () => {
    const bare = `SELECT COUNT(*) AS total FROM Transaction WHERE parentTransactionId IS NULL`
    sqlReplies = [JSON.stringify({ sql: bare })]
    await ask('How many transactions do I have?')

    expect(queryCalls).toEqual([`SELECT COUNT(*) AS total FROM "Transaction" WHERE parentTransactionId IS NULL`])
  })
})

describe('backward compatibility: a model that ignores `format` still works', () => {
  it('falls back to the raw-text path for a plain SQL reply with no JSON envelope', async () => {
    sqlReplies = [PLAIN_SQL]
    const res = await ask('How many transactions do I have?')

    expect(queryCalls).toEqual([PLAIN_SQL])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql: PLAIN_SQL })
  })

  it('falls back to the raw-text path and still strips markdown fences', async () => {
    sqlReplies = [`\`\`\`sql\n${PLAIN_SQL}\n\`\`\``]
    const res = await ask('How many transactions do I have?')

    expect(queryCalls).toEqual([PLAIN_SQL])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql: PLAIN_SQL })
  })

  it('treats a JSON reply with no `sql` field as raw text, not a crash', async () => {
    const weird = `{"query": "${PLAIN_SQL}"}`
    sqlReplies = [weird]
    const res = await ask('How many transactions do I have?')

    // Not valid SQL (still the raw JSON text), so it's declined rather than
    // executed — the point is the route does not throw or 500.
    expect(res.status).toBe(200)
    const out = await frames(res)
    expect(out[0].type).toBe('no-answer')
  })
})

describe('the repair round-trip also uses the JSON format', () => {
  it('sends `format` on the repair call and unwraps its response the same way', async () => {
    const broken = `SELECT COUNT(*) AS total FROM Transactionz`
    sqlReplies = [JSON.stringify({ sql: broken }), JSON.stringify({ sql: PLAIN_SQL })]
    queryResults = [() => { throw new Error('no such table: Transactionz') }]

    const res = await ask('How many transactions do I have?')

    // Initial SQL generation, the repair call, then Phase A verification.
    expect(sqlGenPayloads).toHaveLength(3)
    expect(sqlGenPayloads[1].format).toEqual({
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    })
    expect(queryCalls).toEqual([broken, PLAIN_SQL])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql: PLAIN_SQL })
  })
})
