import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0016 in POST /api/chat: the two money-arithmetic
// shapes that are decidable from the generated SQL alone are declined before
// execution, on both SQL-generation passes, and the decline short-circuits
// rather than buying a repair round-trip.
//
//   1. a sign split with no transactionType predicate — every transfer leg lands
//      in one figure or the other, inflating both;
//   2. a bare SUM(amount) over transfer-pinned rows — cancels to zero whatever
//      was actually moved.
//
// Both are `unsupported-shape`, not `out-of-scope`: the questions are ordinary
// and chat answers both, and what failed is the query we generated. ADR-0014's
// addendum draws that line.
//
// Same mocking pattern as tests/chatCompoundSelectRoute.test.ts — '@/lib/prisma'
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
    if (!next) return { rows: [{ total: 1234.56 }], truncated: false }
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

/** PR #32's first bug, as SQL: two figures split by sign, transfers unaccounted for. */
const UNGUARDED_SIGN_SPLIT =
  `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income, ` +
  `SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses ` +
  `FROM "Transaction" WHERE status IN ('committed','reconciled') ` +
  `AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now'))`

/** PR #32's second bug: transfer volume as a bare SUM. Always approximately zero. */
const NAIVE_TRANSFER_SUM =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
  `WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now'))`

describe('POST /api/chat — sign split with no transactionType guard declined (ADR-0016)', () => {
  it('declines PR #32’s income/expenses query before it runs', async () => {
    sqlReplies = [UNGUARDED_SIGN_SPLIT]

    const res = await ask("What's my income and spending this month?")

    expect(res.status).toBe(200)
    // Declined before execution — this query runs cleanly, which is the problem.
    expect(queryCalls).toEqual([])

    const out = await frames(res)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('unsupported-shape')
    expect(String(out[0].message)).toMatch(/transfer/i)
    expect(String(out[0].message)).toMatch(/too high/i)
    // A non-answer shows its work (ADR-0014).
    expect(out[0].sql).toBe(UNGUARDED_SIGN_SPLIT)
  })

  it('the declined turn never reaches narration', async () => {
    sqlReplies = [UNGUARDED_SIGN_SPLIT]
    const out = await frames(await ask("What's my income and spending this month?"))
    expect(out.map((f) => f.type)).toEqual(['no-answer'])
  })

  it('short-circuits: no repair round-trip is triggered', async () => {
    const spare = `SELECT COUNT(*) AS total FROM "Transaction" LIMIT 200`
    sqlReplies = [UNGUARDED_SIGN_SPLIT, spare]

    await ask("What's my income and spending this month?")

    expect(systemPrompts).toHaveLength(1)
    expect(sqlReplies).toEqual([spare])
    expect(queryCalls).toEqual([])
  })

  it('runs the same query once a transactionType predicate is present', async () => {
    const sql = UNGUARDED_SIGN_SPLIT.replace(
      `WHERE status`,
      `WHERE transactionType != 'transfer' AND status`,
    )
    sqlReplies = [sql]

    const res = await ask("What's my income and spending this month?")

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('checks the repair round-trip too', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    sqlReplies = [broken, UNGUARDED_SIGN_SPLIT]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('What did I earn and spend this month?')

    expect(queryCalls).toEqual([broken])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('unsupported-shape')
    expect(frame.sql).toBe(UNGUARDED_SIGN_SPLIT)
  })
})

describe('POST /api/chat — naive SUM over transfer-pinned rows declined (ADR-0016)', () => {
  it('declines the transfer-volume query that would have returned zero', async () => {
    sqlReplies = [NAIVE_TRANSFER_SUM]

    const res = await ask('How much did I move between my accounts this year?')

    expect(queryCalls).toEqual([])
    const out = await frames(res)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('unsupported-shape')
    // The refusal has to deny the zero explicitly — a confident "nothing" is the
    // wrong answer this check exists to stop.
    expect(String(out[0].message)).toMatch(/zero/i)
    expect(out[0].sql).toBe(NAIVE_TRANSFER_SUM)
  })

  it('runs the conditional form the prompt teaches — the correct volume query', async () => {
    const sql =
      `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total FROM "Transaction" ` +
      `WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now')) ` +
      `AND status IN ('committed','reconciled')`
    sqlReplies = [sql]

    const res = await ask('How much did I move between my accounts this year?')

    // Passes BOTH new detectors: it branches on sign but names a transactionType,
    // and its SUM is conditional rather than bare.
    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
    expect(out.some((f) => f.type === 'token')).toBe(true)
  })

  it('checks the repair round-trip too', async () => {
    const broken = `SELECT SUM(amount) AS total FROM Transactions LIMIT 200`
    sqlReplies = [broken, NAIVE_TRANSFER_SUM]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('How much did I move between accounts?')

    expect(queryCalls).toEqual([broken])
    const [frame] = await frames(res)
    expect(frame.reason).toBe('unsupported-shape')
    expect(frame.sql).toBe(NAIVE_TRANSFER_SUM)
  })

  it('does not fire on a plain aggregate that mentions transfers in a literal', async () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE description LIKE '%transfer fee%' AND transactionType != 'transfer' LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('How much did I pay in transfer fees?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
  })
})

describe('the two refusals are distinguishable from the other guards', () => {
  it('a question containing the word "transfer" is unaffected — only SQL is checked', async () => {
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total FROM "Transaction" ` +
      `WHERE transactionType != 'transfer' LIMIT 200`
    sqlReplies = [sql]

    const res = await ask('How much did I transfer to savings?')

    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
  })

  it('an out-of-scope balance question still reports out-of-scope, not unsupported-shape', async () => {
    // Guard ORDER matters: ADR-0010's alias check runs before these, so a
    // balance query that also lacks a transactionType guard must still be
    // declined as out-of-scope. Getting this backwards tells the user to
    // rephrase a question that is never going to work.
    sqlReplies = [`SELECT SUM(amount) / 100.0 AS total_balance FROM "Transaction" WHERE amount < 0`]

    const out = await frames(await ask('summarise my liabilities by account'))
    expect(out[0].reason).toBe('out-of-scope')
  })
})
