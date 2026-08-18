import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0023: POST /api/chat emits exactly one `result`
// frame, between `sql` and the first `token`, carrying the same rows narration
// saw — and never beside a `no-answer` or an HTTP error.
//
// Same mocking pattern as tests/chatMoneyUnitsRoute.test.ts.
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

/* eslint-disable @typescript-eslint/no-explicit-any */
async function frames(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text()
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

describe('POST /api/chat — the result frame (ADR-0023)', () => {
  it('emits sql, then exactly one result, then tokens', async () => {
    sqlReplies = [`SELECT SUM(amount) AS total_spent FROM "Transaction"`]
    queryResults = [() => ({ rows: [{ total_spent: 123456 }], truncated: false })]

    const out = await frames(await ask('How much did I spend?'))

    expect(out.map((f) => f.type)).toEqual(['sql', 'result', 'token'])
    expect(out.filter((f) => f.type === 'result')).toHaveLength(1)
  })

  it('carries the post-ADR-0020 rows, not the raw cents that came out of SQLite', async () => {
    sqlReplies = [`SELECT SUM(amount) AS total_spent FROM "Transaction"`]
    queryResults = [() => ({ rows: [{ total_spent: 123456 }], truncated: false })]

    const [, result] = await frames(await ask('How much did I spend?'))

    expect(result.rows).toEqual([{ total_spent: 1234.56 }])
    expect(result.columns).toEqual([{ key: 'total_spent', label: 'total_spent', kind: 'money' }])
    expect(result.present).toBe('card')
    expect(result.currency).toBe('AED')
    expect(result.truncated).toBeNull()
    // The same values narration was handed — one row set, not two.
    expect(narrationPrompts[0]).toContain('"total_spent": 1234.56')
  })

  it('classifies a multi-row Transaction projection as transactions', async () => {
    sqlReplies = [`SELECT date, amount, description FROM "Transaction" LIMIT 5`]
    queryResults = [() => ({
      rows: [
        { date: '2026-07-14', amount: -1250, description: 'Coffee' },
        { date: '2026-07-15', amount: -3000, description: 'Lunch' },
      ],
      truncated: false,
    })]

    const [, result] = await frames(await ask('Show me my recent transactions'))

    expect(result.present).toBe('transactions')
    expect(result.rows).toEqual([
      { date: '2026-07-14', amount: -12.5, description: 'Coffee' },
      { date: '2026-07-15', amount: -30, description: 'Lunch' },
    ])
  })

  it('classifies a grouped breakdown as a chart (ADR-0030)', async () => {
    sqlReplies = [`SELECT category, SUM(amount) AS total FROM "Transaction" GROUP BY category`]
    queryResults = [() => ({
      rows: [{ category: '🛒 Groceries', total: -40000 }, { category: '✈️ Travel', total: -90000 }],
      truncated: false,
    })]

    const [, result] = await frames(await ask('What are my top categories?'))

    expect(result.present).toBe('chart')
    expect(result.columns.map((c: { kind: string }) => c.kind)).toEqual(['text', 'money'])
  })

  it('caps rows at the narration cap and reports the truncation from the same source', async () => {
    sqlReplies = [`SELECT date, amount FROM "Transaction"`]
    queryResults = [() => ({
      rows: Array.from({ length: 37 }, (_, i) => ({ date: '2026-07-14', amount: -100 * (i + 1) })),
      truncated: false,
    })]

    const [, result] = await frames(await ask('Show me my transactions'))

    expect(result.rows).toHaveLength(20)
    expect(result.truncated).toEqual({ shown: 20, total: 37, dbCapped: false })
  })

  it('flags a server-side row cap as dbCapped', async () => {
    sqlReplies = [`SELECT date, amount FROM "Transaction"`]
    queryResults = [() => ({
      rows: Array.from({ length: 500 }, () => ({ date: '2026-07-14', amount: -100 })),
      truncated: true,
    })]

    const [, result] = await frames(await ask('Show me my transactions'))

    expect(result.truncated).toEqual({ shown: 20, total: 500, dbCapped: true })
  })

  it('emits no result frame beside a no-answer', async () => {
    sqlReplies = [`SELECT SUM(amount) AS total FROM "Transaction" WHERE 1 = 0`]
    queryResults = [() => ({ rows: [{ total: null }], truncated: false })]

    const out = await frames(await ask('How much did I spend on nothing?'))

    expect(out.map((f) => f.type)).toEqual(['no-answer'])
  })

  it('emits no result frame when a guard declines before execution', async () => {
    sqlReplies = [`SELECT openingBalance AS total_balance FROM Account`]

    const out = await frames(await ask('What is my net worth composed of?'))

    expect(out.some((f) => f.type === 'result')).toBe(false)
    expect(out[0].type).toBe('no-answer')
  })

  it('emits no result frame when narration is unreachable — the failure stays an HTTP status', async () => {
    sqlReplies = [`SELECT SUM(amount) AS total FROM "Transaction"`]
    queryResults = [() => ({ rows: [{ total: 100 }], truncated: false })]

    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body)
      if (payload.stream) throw new Error('connection refused')
      return new Response(JSON.stringify({ response: sqlReplies.shift() ?? 'SELECT 1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const res = await ask('How much did I spend?')

    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('"result"')
  })
})
