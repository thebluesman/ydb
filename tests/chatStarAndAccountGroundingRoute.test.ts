import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_VOCABULARY_CAP, NO_MATCH_SENTINEL } from '@/lib/chatAccountVocabulary'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of the two gaps tests/chatSqlRegressionFixtures.test.ts
// landed as `it.fails` tripwires and this branch closes:
//
//   GAP 1  a SELECT * whose result rows carry openingBalance reaches narration.
//          Closed by checking result-row KEYS after execution — ADR-0010's
//          output-label rule applied where the label only exists post-execution.
//   GAP 2  an Account.name filter matching no stored account runs clean and
//          returns the false-"no data" shape. Closed by ADR-0008's mechanism
//          applied to Account.name.
//
// Same mocking pattern as tests/chatCategoryGroundingRoute.test.ts — '@/lib/prisma'
// replaced wholesale, fake Ollama on global.fetch — because the point is what
// the route does with the model's output, not what the model produces.
//
// The load-bearing assertion in most of these is `systemPrompts.length === 1`:
// one SQL-generation call and no narration call. A refusal that still narrates
// has not refused anything.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries']
const ACCOUNTS = ['ADCB Current', 'Emirates NBD Savings', 'Mashreq Neo Visa']

let storedAccounts: string[] = ACCOUNTS
let queryCalls: string[] = []
let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'AED' }) },
    transaction: { findMany: async () => CATEGORIES.map((category) => ({ category })) },
    account: { findMany: async () => storedAccounts.map((name) => ({ name })) },
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
  storedAccounts = ACCOUNTS
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

describe('GAP 1 — openingBalance arriving via star expansion', () => {
  it('refuses after execution, before narration, when the rows carry openingBalance', async () => {
    const sql = "SELECT * FROM Account WHERE accountType = 'auto_loan' LIMIT 200"
    sqlReplies = [sql]
    queryResults = [() => ({
      rows: [{ id: 4, name: '🚗 Car loan', accountType: 'auto_loan', openingBalance: -703_404 }],
      truncated: false,
    })]

    const res = await ask('show me my loan accounts')

    // The query DID run — it is not judgeable before execution, and the
    // read-only driver is the safety boundary either way.
    expect(queryCalls).toEqual([sql])
    // But narration never happened: one SQL call, no streaming call.
    expect(systemPrompts).toHaveLength(1)

    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).toContain('openingBalance')
    expect(String(frame.message)).toMatch(/dashboard/i)
    // A non-answer shows its work (ADR-0014).
    expect(frame.sql).toBe(sql)
  })

  it('the message does not claim the query was never run', async () => {
    // It was run, and the user can see it on the frame. Saying "I didn't run it"
    // — the pre-execution guards' wording — would be a lie about visible work.
    sqlReplies = ["SELECT * FROM Account LIMIT 200"]
    queryResults = [() => ({ rows: [{ openingBalance: 0 }], truncated: false })]

    const [frame] = await frames(await ask('list my accounts'))
    expect(String(frame.message)).toMatch(/The query ran/)
  })

  it('leaves an ordinary star projection over Transaction alone', async () => {
    // Why this is a row check and not a `SELECT *` ban: this is a perfectly
    // ordinary question with a perfectly ordinary answer.
    const sql = 'SELECT * FROM "Transaction" ORDER BY date DESC LIMIT 20'
    sqlReplies = [sql]
    queryResults = [() => ({
      rows: [{ id: 1, date: '2026-07-02', amount: -12_000, category: '🛒 Groceries' }],
      truncated: false,
    })]

    const res = await ask('show me my recent transactions')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('checks the repaired query too, with no second call site', async () => {
    // The row check sits on `rows`, after both execution branches converge, so
    // the repair path is covered without a duplicated check that could drift.
    const broken = 'SELECT * FROM Accounts'
    const repaired = 'SELECT * FROM Account LIMIT 200'
    sqlReplies = [broken, repaired]
    queryResults = [
      () => { throw new Error('no such table: Accounts') },
      () => ({ rows: [{ id: 1, name: 'ADCB Current', openingBalance: 0 }], truncated: false }),
    ]

    const res = await ask('list my accounts')

    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    // The corrected query is what actually ran, so it is what gets reported.
    expect(frame.sql).toBe(repaired)
  })

  it('a named openingBalance is still stopped before execution, by the text check', async () => {
    // The pre-execution net is unchanged; the row check is an addition, not a
    // replacement. Nothing that could be caught earlier now runs.
    sqlReplies = ['SELECT openingBalance FROM Account LIMIT 200']
    await ask('what are my opening balances?')
    expect(queryCalls).toEqual([])
  })
})

describe('GAP 2 — Account.name grounding', () => {
  it('injects the stored account names into the SQL-generation prompt', async () => {
    sqlReplies = [`SELECT COUNT(*) AS total FROM "Transaction"`]
    await ask('how many transactions?')

    expect(systemPrompts[0]).toContain('Account vocabulary.')
    expect(systemPrompts[0]).toContain(`'Mashreq Neo Visa'`)
    expect(systemPrompts[0]).toContain(`'ADCB Current'`)
  })

  it("refuses session 10's '%credit card%' before execution", async () => {
    const sql =
      'SELECT a.name, SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.name LIKE '%credit card%' GROUP BY a.name"
    sqlReplies = [sql]

    const res = await ask('what did I put on the credit card?')

    // Never executed — this is the whole point. It would have succeeded and
    // returned nothing, and "nothing" would have been narrated as zero.
    expect(queryCalls).toEqual([])
    expect(systemPrompts).toHaveLength(1)

    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).toContain('"%credit card%"')
    expect(String(frame.message)).toMatch(/not the same as nothing having happened/i)
    // Not a dead end: the real names are offered.
    expect(String(frame.message)).toContain('Mashreq Neo Visa')
    expect(frame.sql).toBe(sql)
  })

  it('runs a query whose account literal is copied exactly', async () => {
    const sql =
      'SELECT SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.name = 'ADCB Current'"
    sqlReplies = [sql]

    const res = await ask('what went through ADCB?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('refuses the no-match sentinel without ever showing it to the user', async () => {
    sqlReplies = [
      `SELECT SUM(t.amount) AS total FROM "Transaction" t JOIN Account a ON a.id = t.accountId ` +
        `WHERE a.name = '${NO_MATCH_SENTINEL}'`,
    ]

    const res = await ask('what did I spend on my Revolut card?')

    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).not.toContain(NO_MATCH_SENTINEL)
  })

  it('the repair round-trip carries the same grounding, and is checked independently', async () => {
    const broken =
      `SELECT SUM(t.amount) AS total FROM Transactions t JOIN Account a ON a.id = t.accountId ` +
      `WHERE a.name = 'ADCB Current'`
    const regressed =
      `SELECT SUM(t.amount) AS total FROM "Transaction" t JOIN Account a ON a.id = t.accountId ` +
      `WHERE a.name = 'ADCB'`
    sqlReplies = [broken, regressed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('what went through ADCB?')

    // The repair saw the identical system prompt, vocabulary and all.
    expect(systemPrompts[1]).toBe(systemPrompts[0])
    expect(systemPrompts[1]).toContain(`'ADCB Current'`)
    // Only the failed first attempt ran; the regressed repair was refused.
    expect(queryCalls).toHaveLength(1)

    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(frame.sql).toBe(regressed)
  })

  it('escalates past the account cap instead of grounding on a partial list', async () => {
    storedAccounts = Array.from({ length: ACCOUNT_VOCABULARY_CAP + 1 }, (_, i) => `Account ${i}`)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await ask('what went through ADCB?')

    expect(res.status).toBe(500)
    expect(systemPrompts).toEqual([]) // the model was never called
    expect(String((await res.json()).message)).toMatch(/account names/)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('leaves a query that filters on no account name alone', async () => {
    const sql = `SELECT COUNT(*) AS total FROM "Transaction"`
    sqlReplies = [sql]
    await ask('how many transactions do I have?')
    expect(queryCalls).toEqual([sql])
  })

  it('leaves an accountType filter alone — it is the shape the prompt asks for', async () => {
    const sql =
      'SELECT a.accountType, SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.accountType = 'credit' GROUP BY a.accountType"
    sqlReplies = [sql]
    await ask('what did I put on cards?')
    expect(queryCalls).toEqual([sql])
  })
})
