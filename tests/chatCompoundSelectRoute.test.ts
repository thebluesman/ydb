import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0011 in POST /api/chat: generated SQL containing a
// compound SELECT — UNION, UNION ALL, INTERSECT or EXCEPT — is declined before
// execution, on both SQL-generation passes, and the decline short-circuits rather
// than buying a repair round-trip.
//
// The reason is `unsupported-shape`, not `out-of-scope`: ADR-0014's addendum
// discriminates on what failed, and here the question is ordinary and the
// generated query is what we won't stand behind.
//
// Same mocking pattern as tests/chatBalanceScopeRoute.test.ts and
// tests/chatCategoryGroundingRoute.test.ts — '@/lib/prisma' replaced wholesale,
// fake Ollama on global.fetch — since the point is what the route does with the
// model's output, not what the model produces.
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
    if (!next) return { rows: [{ total_expenses: 49818.75, total_income: 50989.23 }], truncated: false }
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

/** Session 11's question, verbatim — ADR-0011's named regression fixture. */
const SESSION_11_QUESTION = 'If I lose my job, how long could I cover expenses?'

/** And the query it produced: two aggregates stacked, the second alias doomed. */
const SESSION_11_SQL =
  `SELECT SUM(amount) / 100.0 AS total_expenses FROM "Transaction" ` +
  `WHERE amount < 0 AND status IN ('committed','reconciled') ` +
  `UNION ALL ` +
  `SELECT SUM(amount) / 100.0 AS total_income FROM "Transaction" ` +
  `WHERE amount > 0 AND status IN ('committed','reconciled')`

describe('POST /api/chat — compound SELECTs declined (ADR-0011)', () => {
  it('(a) declines session 11: two aggregates stacked with UNION ALL', async () => {
    sqlReplies = [SESSION_11_SQL]

    const res = await ask(SESSION_11_QUESTION)

    expect(res.status).toBe(200)
    // Declined before execution. This query runs cleanly, which is the whole
    // problem: it returned [{total_expenses:-49818.75},{total_expenses:50989.23}]
    // and narration reported the income figure as an expense.
    expect(queryCalls).toEqual([])

    const out = await frames(res)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('unsupported-shape')
    expect(String(out[0].message)).toContain("I couldn't build a single clear result for that")
    expect(String(out[0].message)).toMatch(/one figure at a time/i)
    // A non-answer shows its work (ADR-0014).
    expect(out[0].sql).toBe(SESSION_11_SQL)
  })

  it('the declined turn never reaches narration — no second identically-named column is ever emitted', async () => {
    sqlReplies = [SESSION_11_SQL]

    const out = await frames(await ask(SESSION_11_QUESTION))

    // No `sql` frame, no tokens: the only frame on the wire is the refusal.
    expect(out.map((f) => f.type)).toEqual(['no-answer'])
  })

  it('(b) declines a bare UNION as well as UNION ALL', async () => {
    const sql =
      `SELECT category FROM "Transaction" WHERE amount < 0 ` +
      `UNION SELECT category FROM "Transaction" WHERE amount > 0 LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('What categories have money moving either way?')

    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('unsupported-shape')
    expect(frame.sql).toBe(sql)
  })

  it('(c) declines a lowercase `union all`', async () => {
    const sql = SESSION_11_SQL.replace('UNION ALL', 'union all')
    sqlReplies = [sql]

    const res = await ask(SESSION_11_QUESTION)

    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.reason).toBe('unsupported-shape')
    expect(String(frame.message)).toContain('UNION ALL')
  })

  it('declines a synthetic INTERSECT', async () => {
    const sql =
      `SELECT category AS spent_in FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-05' ` +
      `INTERSECT ` +
      `SELECT category AS also_spent_in FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-06' LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('Which categories did I spend in both May and June?')

    expect(queryCalls).toEqual([])
    const out = await frames(res)
    expect(out.map((f) => f.type)).toEqual(['no-answer'])
    expect(out[0].reason).toBe('unsupported-shape')
    expect(String(out[0].message)).toContain('INTERSECT')
    expect(out[0].sql).toBe(sql)
  })

  it('declines a synthetic EXCEPT', async () => {
    const sql =
      `SELECT category AS dropped FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-05' ` +
      `EXCEPT ` +
      `SELECT category AS kept FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-06' LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('Which categories did I stop spending in?')

    expect(queryCalls).toEqual([])
    const out = await frames(res)
    expect(out.map((f) => f.type)).toEqual(['no-answer'])
    expect(out[0].reason).toBe('unsupported-shape')
    expect(String(out[0].message)).toContain('EXCEPT')
    // Generic phrasing: an EXCEPT refusal must not blame UNION.
    expect(String(out[0].message)).not.toMatch(/\bUNION\b/i)
    expect(out[0].sql).toBe(sql)
  })

  it('(f) short-circuits for all three operators: no repair round-trip is triggered', async () => {
    const spare = `SELECT SUM(amount) AS total FROM "Transaction" LIMIT 200`
    const offenders = [
      SESSION_11_SQL,
      `SELECT category AS a FROM "Transaction" INTERSECT SELECT category AS b FROM "Transaction" LIMIT 200`,
      `SELECT category AS a FROM "Transaction" EXCEPT SELECT category AS b FROM "Transaction" LIMIT 200`,
    ]

    for (const offender of offenders) {
      queryCalls = []
      systemPrompts = []
      // A second reply is queued precisely to prove it is never consumed.
      sqlReplies = [offender, spare]

      await ask(SESSION_11_QUESTION)

      // Exactly one model call: the first generation. No repair, no narration.
      expect(systemPrompts, offender).toHaveLength(1)
      expect(sqlReplies, offender).toEqual([spare])
      expect(queryCalls, offender).toEqual([])
    }
  })

  it('(d) does not falsely reject a query whose text merely contains "union"', async () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE description LIKE '%reunion%' AND status IN ('committed','reconciled') LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('How much did the reunion cost me?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('(g) runs the conditional-aggregate shape the prompt now teaches', async () => {
    // Session 11's question, answered the right way: two figures, two columns,
    // one row — labels intact.
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses, ` +
      `SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income ` +
      `FROM "Transaction" WHERE status IN ('committed','reconciled') LIMIT 200`
    sqlReplies = [sql]

    const res = await ask(SESSION_11_QUESTION)

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
    // Narration ran, and it was handed distinctly-named columns.
    expect(out.some((f) => f.type === 'token')).toBe(true)
  })

  it('(e) checks the repair round-trip too', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    const regressed = SESSION_11_SQL
    sqlReplies = [broken, regressed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('What did I spend and earn this month?')

    // Only the failed first attempt reached the DB; the repair was declined.
    expect(queryCalls).toEqual([broken])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('unsupported-shape')
    expect(frame.sql).toBe(regressed)
  })

  it('(e2) a repair with no compound select still runs normally', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    const fixed = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" LIMIT 200`
    sqlReplies = [broken, fixed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('What did I spend this month?')

    expect(queryCalls).toEqual([broken, fixed])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql: fixed })
  })

  it('does not falsely reject an identifier containing "except" or "intersect"', async () => {
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS except_flag, ` +
      `COUNT(*) AS intersect_count FROM "Transaction" ` +
      `WHERE status IN ('committed','reconciled') LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('How many debits do I have?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('carries the compound-SELECT rule into both SQL-generation prompts', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    const fixed = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" LIMIT 200`
    sqlReplies = [broken, fixed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    await ask('What did I spend this month?')

    expect(systemPrompts[0]).toMatch(/NEVER use UNION, UNION ALL, INTERSECT or EXCEPT/)
    expect(systemPrompts[1]).toBe(systemPrompts[0])
  })

  it('a question containing the word "union" is unaffected — only SQL is checked', async () => {
    // ADR-0011 § Consequences, made explicit at the route boundary.
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('How much do I pay in union dues each month?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
  })
})
