import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATEGORY_VOCABULARY_CAP, NO_MATCH_SENTINEL } from '@/lib/chatCategoryVocabulary'

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

// PR #29's live bug had a real, distinct catch-all bucket in the vocabulary —
// that's the whole reason the substitution was invisible to the old guard.
const CATEGORIES_WITH_CATCHALL = ['✈️ Travel', '🛒 Groceries', '🏠 Rent', 'Uncategorized']

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

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up fix, live-tested on PR #29 before merge (2026-07-29): "What was
// spent on Sports in July" — not a real category — was answered as a
// confident 7,372.68 AED, generated against `category = 'Uncategorized'`.
// 'Uncategorized' is a real, grounded value, so the ADR-0008 guard (which only
// checks groundedness, not correctness) let it straight through. Same
// silent-wrong-answer class ADR-0008 exists to kill; this time the model
// substituted a genuine value instead of inventing a fake one.
//
// IMPORTANT about what this test suite can and can't prove: a hardcoded
// `category = 'Uncategorized'` SQL reply, fed through this route's guard, WILL
// run — 'Uncategorized' is a real, grounded value, and the guard is
// deliberately groundedness-only (ADR-0008's "grounding beats normalising").
// Adding a guard-level check for "does this real literal actually relate to
// the question" would mean scoring lexical similarity between the user's
// words and the category name in the decision path itself — exactly the
// fuzzy-matching failure mode ADR-0008 rejected, just moved from "picking an
// answer" to "vetoing one", and it would false-refuse legitimately-reworded
// questions (e.g. "eating out" -> "🍽️ Dining out") that don't share a
// substring with the stored name.
//
// So the fix here is at the prompt layer: give the model an explicit,
// vocabulary-external sentinel literal for "nothing corresponds" (see
// NO_MATCH_SENTINEL in lib/chatCategoryVocabulary.ts), removing the
// contradiction that pushed the model toward 'Uncategorized' as a "safe"
// grounded-looking way out. That was verified against live Ollama
// (qwen2.5:32b) with the real dev-DB vocabulary (46 categories, including a
// real 'Uncategorized' entry): pre-fix, "What was spent on Sports in July"
// generated `category = 'Uncategorized'`; post-fix, the identical question
// against the identical vocabulary generated
// `category = '__no_matching_category__'`, which the existing groundedness
// guard already rejects with zero new detection logic. The route-level test
// below covers the half that's actually mechanizable without live Ollama: if
// the model follows the new prompt and emits the sentinel, it is refused
// correctly and the sentinel is never shown to the user.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/chat — real-category substitution (PR #29 live bug)', () => {
  it('refuses when the model follows the new prompt rule and emits the no-match sentinel', async () => {
    storedCategories = CATEGORIES_WITH_CATCHALL
    sqlReplies = [
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '${NO_MATCH_SENTINEL}' AND strftime('%Y-%m', date) = '2026-07' AND status IN ('committed','reconciled') LIMIT 200`,
    ]

    const res = await ask('What was spent on Sports in July')

    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    // The sentinel is a server-internal signal, never something to show the user.
    expect(String(frame.message)).not.toContain(NO_MATCH_SENTINEL)
  })

  it('sibling case: a made-up category lexically close to a real one is still refused, not silently corrected', async () => {
    storedCategories = CATEGORIES_WITH_CATCHALL
    // "Grocery" (singular, no emoji) is close to the stored '🛒 Groceries' but
    // is not an exact copy — the closed-list rule requires exact copy, so this
    // must be refused rather than treated as "close enough".
    sqlReplies = [`SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Grocery'`]

    const res = await ask('What did I spend on Grocery this month?')

    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).toContain('"Grocery"')
    expect(String(frame.message)).toContain('🛒 Groceries') // closest stored name still offered
  })

  it('sibling case: a made-up category with no lexical relationship to anything stored is refused with no bogus suggestion', async () => {
    storedCategories = CATEGORIES_WITH_CATCHALL
    sqlReplies = [`SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Astrology'`]

    const res = await ask('What did I spend on Astrology this year?')

    expect(queryCalls).toEqual([])
    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(String(frame.message)).toContain('"Astrology"')
    expect(String(frame.message)).not.toMatch(/closest stored/) // nothing plausible to suggest
  })
})
