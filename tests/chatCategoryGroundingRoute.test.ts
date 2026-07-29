import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATEGORY_VOCABULARY_CAP } from '@/lib/chatCategoryVocabulary'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0008 in POST /api/chat: the vocabulary reaches
// the model, an ungrounded literal is refused before execution, and the repair
// round-trip carries the same grounding.
//
// Same mocking pattern as tests/transactionsApi.test.ts — '@/lib/prisma' is
// replaced wholesale — plus a fake Ollama on global.fetch, since the point is
// what the route does with the model's output, not what the model produces.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', '🏠 Rent']

/** What the fake ledger has stored; overridden by the cap test. */
let storedCategories: string[] = CATEGORIES

let queryCalls: string[] = []
let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'USD' }) },
    transaction: {
      findMany: async () => storedCategories.map((category) => ({ category })),
    },
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

/** Every `system` prompt the fake Ollama was handed, in call order. */
let systemPrompts: string[] = []
/** SQL the fake model returns, one per /api/generate call. */
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
  storedCategories = CATEGORIES
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

describe('POST /api/chat — category vocabulary grounding (ADR-0008)', () => {
  it('injects the stored vocabulary into the SQL-generation prompt', async () => {
    sqlReplies = [`SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = '✈️ Travel'`]
    await ask('How much did I spend on travel?')

    expect(systemPrompts[0]).toContain(`'✈️ Travel'`)
    expect(systemPrompts[0]).toContain(`'🛒 Groceries'`)
    expect(systemPrompts[0]).toMatch(/MUST be copied exactly/)
  })

  it('(a) runs a query whose category literal matches the stored vocabulary', async () => {
    const sql = `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = '✈️ Travel'`
    sqlReplies = [sql]

    const res = await ask('How much did I spend on travel?')

    expect(res.status).toBe(200)
    expect(queryCalls).toEqual([sql])
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql })
    expect(out.some((f) => f.type === 'no-answer')).toBe(false)
  })

  it('(b) refuses an unmatched category loudly instead of running it to an empty aggregate', async () => {
    // The live bug, verbatim: the model guesses the bare name for a stored
    // value that is emoji-prefixed.
    sqlReplies = [`SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Travel'`]

    const res = await ask('How much did I spend on Travel this year?')

    expect(res.status).toBe(200)
    // The refusal happens before execution — the whole point is that this query
    // would have succeeded and returned [{total: null}].
    expect(queryCalls).toEqual([])

    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).toContain("I don't have a category matching \"Travel\"")
    expect(String(frame.message)).toContain('✈️ Travel') // closest stored name offered
    expect(String(frame.message)).toMatch(/not the same as spending nothing/)
    // A non-answer shows its work (ADR-0014).
    expect(frame.sql).toContain(`category = 'Travel'`)
  })

  it("(b') never narrates an unmatched category, so no narration call is made", async () => {
    sqlReplies = [`SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Holidays'`]
    await ask('What did I spend on Holidays?')
    // One SQL-generation call, and nothing streamed after it.
    expect(systemPrompts).toHaveLength(1)
  })

  it('(c) the repair round-trip carries the same vocabulary block', async () => {
    const broken = `SELECT SUM(amount)/100.0 AS total FROM Transactions WHERE category = '✈️ Travel'`
    const fixed = `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = '✈️ Travel'`
    sqlReplies = [broken, fixed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('How much did I spend on travel?')

    // Two SQL-generation calls, and the repair saw the identical system prompt
    // — vocabulary and date grounding both.
    expect(systemPrompts.length).toBeGreaterThanOrEqual(2)
    expect(systemPrompts[1]).toBe(systemPrompts[0])
    expect(systemPrompts[1]).toContain(`'✈️ Travel'`)

    expect(queryCalls[1]).toBe(fixed)
    const out = await frames(res)
    expect(out[0]).toMatchObject({ type: 'sql', sql: fixed })
  })

  it('(c2) a repair that reintroduces a guessed literal is refused, not executed', async () => {
    const broken = `SELECT SUM(amount)/100.0 AS total FROM Transactions WHERE category = '✈️ Travel'`
    const regressed = `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Travel'`
    sqlReplies = [broken, regressed]
    queryResults = [() => { throw new Error('no such table: Transactions') }]

    const res = await ask('How much did I spend on travel?')

    expect(queryCalls).toHaveLength(1) // only the failed first attempt ran
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(frame.sql).toContain(`category = 'Travel'`)
  })

  it('escalates past the vocabulary cap instead of grounding on a partial list', async () => {
    storedCategories = Array.from({ length: CATEGORY_VOCABULARY_CAP + 1 }, (_, i) => `Cat ${i}`)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await ask('How much did I spend on travel?')

    expect(res.status).toBe(500)
    expect(systemPrompts).toEqual([]) // the model was never called
    expect(String((await res.json()).message)).toMatch(/categories/)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('leaves a query that filters on no category alone', async () => {
    const sql = `SELECT COUNT(*) AS total FROM "Transaction"`
    sqlReplies = [sql]
    await ask('How many transactions do I have?')
    expect(queryCalls).toEqual([sql])
  })
})
