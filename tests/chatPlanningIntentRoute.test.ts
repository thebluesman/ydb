import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0029 in POST /api/chat: a planning/forecast/goal
// question is declined before any SQL is generated. Same mocking pattern as
// tests/chatBalanceScopeRoute.test.ts — the point is what the route does with
// the question, not what a model would have produced for it.
//
// ADR-0029 § Consequences names the required fixture pair explicitly: both
// production cases declined with the Ollama SQL call asserted never to
// happen, and a past-tense question containing a planning word must still
// generate SQL.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', 'YNAB']
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
  return POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }),
  )
}

async function frames(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

describe('POST /api/chat — planning questions out of scope (ADR-0029)', () => {
  it.each([
    // ADR-0029 § Context, verbatim production cases.
    'What should I budget for next month?',
    'Am I on track to hit my savings goal?',
  ])('declines %j before any SQL is generated', async (question) => {
    const res = await ask(question)

    expect(res.status).toBe(200)
    expect(queryCalls).toEqual([])
    // No model call at all — not even for SQL generation, since the decline
    // fires before the SQL-gen fetch.
    expect(systemPrompts).toHaveLength(0)

    const [frame] = await frames(res)
    expect(frame.type).toBe('no-answer')
    expect(frame.reason).toBe('out-of-scope')
    expect(frame.sql).toBeUndefined()
    expect(String(frame.message)).toMatch(/recorded transactions/i)
  })

  it('lets a past-tense question containing a planning word reach SQL generation', async () => {
    sqlReplies = [`SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = 'YNAB' LIMIT 200`]

    const res = await ask('How much did I spend on my savings transfers last month?')

    expect(res.status).toBe(200)
    expect(queryCalls).toHaveLength(1)
    expect(systemPrompts.length).toBeGreaterThan(0)
  })
})
