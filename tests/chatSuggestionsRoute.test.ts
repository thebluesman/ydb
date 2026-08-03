import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0024: POST /api/chat emits at most one
// `suggestions` frame, after `sql`/`result` and BEFORE the first token — the
// general ordering rule the ADR fixes, "the token stream is always last".
//
// And the negative half, which is the load-bearing one: a `no-answer` still
// arrives alone (ADR-0014), and a query whose shape cannot be resolved gets no
// frame at all rather than an empty one or an error.
//
// Same mocking pattern as tests/chatResultFrameRoute.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', '🏠 Rent']
const ACCOUNTS = ['ADCB Current', 'Emirates NBD Savings']

let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'AED' }) },
    transaction: { findMany: async () => CATEGORIES.map((category) => ({ category })) },
    account: { findMany: async () => ACCOUNTS.map((name) => ({ name })) },
  },
  executeReadonlyQuery: () => {
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
  queryResults = []
  narrationPrompts = []
  sqlReplies = []

  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    if (payload.stream) {
      narrationPrompts.push(payload.prompt)
      return narrationStream()
    }
    const sql = sqlReplies.shift() ?? 'SELECT 1'
    return new Response(JSON.stringify({ response: JSON.stringify({ sql }) }), { status: 200 })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function ask(question: string): Promise<Record<string, unknown>[]> {
  const res = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }),
  )
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const CATEGORY_MONTH_SQL =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🛒 Groceries' ` +
  `AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL ` +
  `AND strftime('%Y-%m', date) = '2026-06' AND status IN ('committed','reconciled')`

describe('the suggestions frame on the answer path', () => {
  it('arrives once, after sql and result, before the first token', async () => {
    sqlReplies = [CATEGORY_MONTH_SQL]
    const frames = await ask('How much did I spend on groceries in June?')

    const types = frames.map((f) => f.type)
    expect(types.filter((t) => t === 'suggestions')).toHaveLength(1)

    const suggestionsAt = types.indexOf('suggestions')
    expect(types.indexOf('sql')).toBeLessThan(suggestionsAt)
    expect(types.indexOf('result')).toBeLessThan(suggestionsAt)
    expect(suggestionsAt).toBeLessThan(types.indexOf('token'))
  })

  it('carries the declared shape, and nothing from the rows', async () => {
    sqlReplies = [CATEGORY_MONTH_SQL]
    const frames = await ask('How much did I spend on groceries in June?')
    const frame = frames.find((f) => f.type === 'suggestions') as {
      questions: { text: string; template: string }[]
    }

    expect(frame.questions.length).toBeGreaterThan(0)
    expect(frame.questions.length).toBeLessThanOrEqual(3)
    for (const q of frame.questions) {
      expect(typeof q.text).toBe('string')
      expect(typeof q.template).toBe('string')
      // Every slot is a route-resolved period or a vocabulary literal. The
      // narration text ("Answer.") is the mocked model output; if any of it
      // reached a suggestion, the taint boundary ADR-0024 draws is broken.
      expect(q.text).not.toContain('Answer.')
    }
  })

  it('the token stream is last — nothing non-prose follows the first token', async () => {
    sqlReplies = [CATEGORY_MONTH_SQL]
    const types = (await ask('How much did I spend on groceries in June?')).map((f) => f.type)
    const firstToken = types.indexOf('token')
    expect(firstToken).toBeGreaterThan(-1)
    expect(types.slice(firstToken).every((t) => t === 'token')).toBe(true)
  })

  it('is omitted, silently and without an error, when no period resolves', async () => {
    sqlReplies = [`SELECT COUNT(*) AS total FROM "Transaction" WHERE status IN ('committed','reconciled')`]
    const frames = await ask('How many transactions do I have?')

    expect(frames.map((f) => f.type)).not.toContain('suggestions')
    expect(frames.map((f) => f.type)).not.toContain('error')
    expect(frames.some((f) => f.type === 'result')).toBe(true)
    expect(frames.some((f) => f.type === 'token')).toBe(true)
  })
})

describe('a no-answer still arrives alone (ADR-0014)', () => {
  it('a refused balance question carries no suggestions frame and no questions field', async () => {
    const frames = await ask("What's the balance on my car loan?")
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('no-answer')
    expect(frames[0]).not.toHaveProperty('questions')
  })

  it('a no-data refusal carries no suggestions either, even though its SQL resolves', async () => {
    // This is the case where a suggestion would have been composable: the SQL
    // names June and a real category. It is deliberately not offered — see the
    // PR notes on the no-answer/suggestions interaction.
    sqlReplies = [CATEGORY_MONTH_SQL]
    queryResults = [() => ({ rows: [{ total: null }], truncated: false })]
    const frames = await ask('How much did I spend on groceries in June?')

    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('no-answer')
    expect(frames[0].reason).toBe('no-data')
    expect(frames[0]).not.toHaveProperty('questions')
  })
})

describe('the recap narration variant ([chat-model] output 13)', () => {
  it('appends its instruction after the data fence on a recap question', async () => {
    sqlReplies = [
      `SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE strftime('%Y-%m', date) = '2026-06' AND transactionType != 'transfer' GROUP BY category`,
    ]
    queryResults = [() => ({ rows: [{ category: '🛒 Groceries', total: 412.3 }], truncated: false })]
    await ask('Give me a recap of June')

    const prompt = narrationPrompts[0]
    expect(prompt).toContain('three to five sentences')
    // After the closing marker, never inside the declared-verbatim data region.
    expect(prompt.indexOf('QUERY_RESULT_END>>>')).toBeLessThan(prompt.indexOf('three to five sentences'))
  })

  it('appends nothing on an ordinary question', async () => {
    sqlReplies = [CATEGORY_MONTH_SQL]
    await ask('How much did I spend on groceries in June?')
    expect(narrationPrompts[0]).not.toContain('three to five sentences')
  })
})
