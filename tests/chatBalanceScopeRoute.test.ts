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
const ACCOUNTS = ['ADCB Current', 'Emirates NBD Savings']

let queryCalls: string[] = []
let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'AED' }) },
    transaction: { findMany: async () => CATEGORIES.map((category) => ({ category })) },
    // Account-name grounding reads this per turn (ADR-0008's mechanism on
    // Account.name); these suites are not about it, so it stays a fixed list.
    account: { findMany: async () => ACCOUNTS.map((name) => ({ name })) },
  },
  executeReadonlyQuery: (sql: string) => {
    queryCalls.push(sql)
    const next = queryResults.shift()
    if (!next) return { rows: [{ total: 42.5 }], truncated: false }
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

    // Question deliberately free of stock nouns: ADR-0015 now declines "what is
    // my net worth" before generation, and this case is about the SQL check.
    const res = await ask('How much is on each of my accounts?')

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

    // Same reason as (a): "how much is left on" is ADR-0015 vocabulary, and this
    // case has to reach the repair round-trip to test anything.
    const res = await ask('How much did I put on my card this month?')

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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0015 supersedes ADR-0010's placement: the decline happens on the question,
// before any SQL is generated. The assertion that matters in every case here is
// `systemPrompts` staying empty — no Ollama call on the SQL path at all. A
// response that merely "looks right" would still be a pass for the old
// mechanism.
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/chat — balance intent declined before generation (ADR-0015)', () => {
  it("declines Shyam's live session question and never generates SQL", async () => {
    // The whole reason PR #30 didn't merge: this question produced
    // `SUM(amount) AS net`, an alias no blocklist would hold, and narration
    // answered "The balance on your car loan is AED 7034.04".
    sqlReplies = [`SELECT SUM(amount) / 100.0 AS net FROM "Transaction" LIMIT 200`]

    const res = await ask("What's the balance on my car loan?")

    expect(res.status).toBe(200)
    // Nothing was asked of the model, on either phase.
    expect(systemPrompts).toEqual([])
    expect(queryCalls).toEqual([])

    const out = await frames(res)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('out-of-scope')
    expect(String(out[0].message)).toMatch(/net flow/i)
    expect(String(out[0].message)).toMatch(/dashboard/i)
    // No SQL was generated, so the frame carries none (contrast the ADR-0010
    // cases above, which show the query they refused).
    expect(out[0]).not.toHaveProperty('sql')
  })

  it.each([
    'What is my net worth?',
    'What do I owe on the car?',
    'What is my outstanding balance right now?',
    'How much is left on my loan?',
    'How much debt do I have?',
  ])('declines %j with no model call', async (question) => {
    const res = await ask(question)

    expect(systemPrompts).toEqual([])
    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
  })

  it('lets the pay-off flow question through to SQL generation', async () => {
    // ADR-0015's named trap: a legitimate flow question containing "pay off".
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE category = '🏠 Rent' AND date >= date('now','-1 month') LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('how much did I pay off my car loan last month')

    // Generation happened, the query ran, and the turn narrated normally.
    expect(systemPrompts).toHaveLength(2)
    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('checks the current question only — a prior balance turn does not poison it', async () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" LIMIT 200`
    sqlReplies = [sql]

    const res = await POST(new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'How much did I spend on rent last month?',
        history: [
          { role: 'user', text: "What's the balance on my car loan?" },
          { role: 'assistant', text: 'I can only answer flow questions.' },
        ],
      }),
    }))

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
  })
})
