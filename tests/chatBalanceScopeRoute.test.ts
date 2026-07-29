import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0010 in POST /api/chat: a balance-asserting
// result alias (or any openingBalance reference) is declined before execution,
// on both SQL-generation passes, and the decline short-circuits rather than
// buying a repair round-trip.
//
// Same mocking pattern as tests/chatCategoryGroundingRoute.test.ts — '@/lib/prisma'
// replaced wholesale, fake Ollama on global.fetch — since the point is what the
// route does with the model's output, not what the model produces.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', '🏠 Rent']

let queryCalls: string[] = []
let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'AED' }) },
    transaction: { findMany: async () => CATEGORIES.map((category) => ({ category })) },
  },
  executeReadonlyQuery: (sql: string) => {
    queryCalls.push(sql)
    const next = queryResults.shift()
    if (!next) return { rows: [{ total: 42.5 }], truncated: false }
    return next()
  },
}))

vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: async () => ({ ollamaUrl: 'http://ollama.test', chatModel: 'qwen2.5:32b' }),
}))

const { POST } = await import('@/app/api/chat/route')

let systemPrompts: string[] = []
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
  systemPrompts = []
  sqlReplies = []

  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    systemPrompts.push(payload.system)
    if (payload.stream) return narrationStream()
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

/** Session 10's query, verbatim — ADR-0010's named regression fixture. */
const SESSION_10_SQL =
  `SELECT Account.name, SUM("Transaction".amount) / 100.0 AS total_balance ` +
  `FROM "Transaction" JOIN Account ON "Transaction".accountId = Account.id ` +
  `WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) ` +
  `AND Account.accountType = 'loan' GROUP BY Account.name LIMIT 200`

describe('POST /api/chat — balance semantics out of scope (ADR-0010)', () => {
  it('(e) declines session 10: a liability-account SUM(amount) aliased as a balance', async () => {
    sqlReplies = [SESSION_10_SQL]

    const res = await ask('Which loan should I pay off first?')

    expect(res.status).toBe(200)
    // Declined before execution — this query would have run cleanly and been
    // narrated as "a car loan with a total balance of AED 2344.68".
    expect(queryCalls).toEqual([])

    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).toMatch(/net flow/i)
    expect(String(frame.message)).toMatch(/dashboard/i)
    // A non-answer shows its work (ADR-0014).
    expect(frame.sql).toBe(SESSION_10_SQL)
  })

  it('(e2) never narrates it — the decline short-circuits, no repair round-trip', async () => {
    sqlReplies = [SESSION_10_SQL, `SELECT SUM(amount) AS total FROM "Transaction"`]
    await ask('Which loan should I pay off first?')
    // Exactly one model call: no repair attempt, no narration.
    expect(systemPrompts).toHaveLength(1)
  })

  it('(a) declines a query referencing Account.openingBalance', async () => {
    sqlReplies = [`SELECT name, openingBalance / 100.0 AS opening FROM Account LIMIT 200`]

    const res = await ask('What is my net worth?')

    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).toMatch(/openingBalance/)
  })

  it.each(['balance', 'net_worth', 'outstanding', 'owed'])(
    '(b) declines a result column aliased %s',
    async (alias) => {
      sqlReplies = [`SELECT SUM(amount) / 100.0 AS ${alias} FROM "Transaction" LIMIT 200`]

      const res = await ask('How much do I have?')

      expect(queryCalls).toEqual([])
      const [frame] = await frames(res)
      expect(frame.type).toBe('no-answer')
      expect(frame.reason).toBe('out-of-scope')
    },
  )

  it('(c) runs an ordinary aggregate with an innocuous alias', async () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE category = '🛒 Groceries' AND status IN ('committed','reconciled') LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('How much did I spend on groceries?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('(c2) runs a per-account monthly flow aliased net_flow', async () => {
    const sql = SESSION_10_SQL.replace('total_balance', 'net_flow')
    sqlReplies = [sql]

    const res = await ask('What was the net flow on my loan this month?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
  })

  it('(d) checks the repair round-trip too', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    const regressed = `SELECT SUM(amount) / 100.0 AS total_balance FROM "Transaction" LIMIT 200`
    sqlReplies = [broken, regressed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('How much is left on my card?')

    // Only the failed first attempt reached the DB; the repair was declined.
    expect(queryCalls).toEqual([broken])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(frame.sql).toBe(regressed)
  })

  it('(d2) a repair that stays in scope still runs normally', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    const fixed = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" LIMIT 200`
    sqlReplies = [broken, fixed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('What did I spend this month?')

    expect(queryCalls).toEqual([broken, fixed])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql: fixed })
  })

  it('carries the balance rules into both SQL-generation prompts', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    const fixed = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" LIMIT 200`
    sqlReplies = [broken, fixed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    await ask('What did I spend this month?')

    expect(systemPrompts[0]).toMatch(/NET FLOW/)
    expect(systemPrompts[1]).toBe(systemPrompts[0])
  })
})
