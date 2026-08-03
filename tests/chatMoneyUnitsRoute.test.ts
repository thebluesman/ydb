import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0020 in POST /api/chat: units are decided
// server-side, before rows reach narration, replacing the old "infer from
// context" narration-prompt hedge.
//
// Same mocking pattern as tests/chatMoneyGuardsRoute.test.ts — '@/lib/prisma'
// replaced wholesale, fake Ollama on global.fetch.
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

let narrationPrompts: string[] = []
let narrationSystemPrompts: string[] = []
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
  narrationPrompts = []
  narrationSystemPrompts = []
  sqlReplies = []

  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    if (payload.stream) {
      narrationPrompts.push(payload.prompt)
      narrationSystemPrompts.push(payload.system)
      return narrationStream()
    }
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

describe('POST /api/chat — raw row-level amounts converted before narration (ADR-0020)', () => {
  it('divides a raw amount column by 100 before it reaches the narration prompt', async () => {
    const sql = `SELECT date, description, amount FROM "Transaction" WHERE parentTransactionId IS NULL LIMIT 5`
    sqlReplies = [sql]
    queryResults = [() => ({
      rows: [{ date: '2026-01-01', description: 'Coffee', amount: -1250 }],
      truncated: false,
    })]

    const res = await ask('Show me my recent transactions')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)

    expect(narrationPrompts).toHaveLength(1)
    expect(narrationPrompts[0]).toContain('"amount": -12.5')
    expect(narrationPrompts[0]).not.toContain('-1250')
  })

  it('a SELECT * over Transaction converts the amount column via star expansion', async () => {
    const sql = `SELECT * FROM "Transaction" WHERE parentTransactionId IS NULL LIMIT 1`
    sqlReplies = [sql]
    queryResults = [() => ({
      rows: [{ id: 1, amount: -500, description: 'Test', category: 'Groceries' }],
      truncated: false,
    })]

    await ask('Show me my recent transactions')

    expect(narrationPrompts[0]).toContain('"amount": -5')
  })

  it('an already-converted aggregate (contains /100.0) is not double-divided', async () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction"`
    sqlReplies = [sql]
    queryResults = [() => ({ rows: [{ total: 123.45 }], truncated: false })]

    await ask('How much did I spend?')

    expect(narrationPrompts[0]).toContain('"total": 123.45')
  })

  it('narration is told units are already normalized, with no inference clause', async () => {
    sqlReplies = [`SELECT SUM(amount) / 100.0 AS total FROM "Transaction"`]
    queryResults = [() => ({ rows: [{ total: 1 }], truncated: false })]

    await ask('How much did I spend?')

    expect(narrationSystemPrompts).toHaveLength(1)
    expect(narrationSystemPrompts[0]).toMatch(/already in AED currency units/i)
    expect(narrationSystemPrompts[0]).not.toMatch(/infer from context/i)
  })
})

describe('POST /api/chat — unresolvable money projections declined (ADR-0020)', () => {
  it('declines a CTE before it runs', async () => {
    const sql = `WITH x AS (SELECT SUM(amount) AS s FROM "Transaction") SELECT s / 100.0 AS total FROM x`
    sqlReplies = [sql]

    const res = await ask('How much did I spend?')

    expect(queryCalls).toEqual([])
    const out = await frames(res)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('unsupported-shape')
    expect(out[0].sql).toBe(sql)
  })

  it('declines a bare star over a multi-table join', async () => {
    const sql = `SELECT * FROM "Transaction" t JOIN Account a ON t.accountId = a.id LIMIT 5`
    sqlReplies = [sql]

    const res = await ask('Show me my transactions with account details')

    expect(queryCalls).toEqual([])
    const out = await frames(res)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('unsupported-shape')
  })

  it('declines a money ratio with no /100 anywhere, rather than guess a unit', async () => {
    const sql =
      `SELECT SUM(CASE WHEN category = '🛒 Groceries' THEN -amount ELSE 0 END) / ` +
      `SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS pct FROM "Transaction"`
    sqlReplies = [sql]

    const res = await ask('What percentage of my spending was groceries?')

    expect(queryCalls).toEqual([])
    const out = await frames(res)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('unsupported-shape')
  })

  it('checks the repair round-trip too', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions`
    const cte = `WITH x AS (SELECT SUM(amount) AS s FROM "Transaction") SELECT s AS total FROM x`
    sqlReplies = [broken, cte]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('How much did I spend?')

    expect(queryCalls).toEqual([broken])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('unsupported-shape')
    expect(frame.sql).toBe(cte)
  })
})

describe('a NULL aggregate is unaffected by unit conversion', () => {
  it('still reaches the no-data check as NULL, not 0', async () => {
    sqlReplies = [`SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE 1 = 0`]
    queryResults = [() => ({ rows: [{ total: null }], truncated: false })]

    const out = await frames(await ask('How much did I spend on nonexistent category?'))

    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('no-data')
  })
})
