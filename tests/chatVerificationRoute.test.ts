import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of Phase A (ADR-0025/0026) in POST /api/chat: a
// `mismatch` or `out-of-scope` verdict from the verifier routes to the
// no-answer frame instead of narration; `ok` and `unusable` (the fail-open
// case) both narrate; every turn that reaches the verifier writes a
// ChatVerdict row, and the model's own `reason` text never reaches the client.
//
// Same mocking pattern as tests/chatResultFrameRoute.test.ts, with the prisma
// mock extended to capture ChatVerdict.create calls.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', '🏠 Rent']
const ACCOUNTS = ['ADCB Current', 'Emirates NBD Savings']

let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []
let verdictCreateCalls: Record<string, unknown>[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'AED' }) },
    transaction: { findMany: async () => CATEGORIES.map((category) => ({ category })) },
    account: { findMany: async () => ACCOUNTS.map((name) => ({ name })) },
    chatVerdict: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        verdictCreateCalls.push(data)
        return { id: verdictCreateCalls.length, createdAt: new Date(), ...data }
      },
    },
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

let sqlReplies: string[] = []
/** Queued raw `response` bodies for the verification call, consumed in order. */
let verifyReplies: string[] = []

function narrationStream(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ response: 'Answer.' }) + '\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

function verifyReply(verdict: 'ok' | 'mismatch' | 'out-of-scope', reason: string): string {
  return JSON.stringify({ reason, verdict })
}

beforeEach(() => {
  queryResults = []
  verdictCreateCalls = []
  sqlReplies = []
  verifyReplies = []

  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    if (payload.stream) return narrationStream()
    // Distinguish the SQL-gen/repair call from the verification call by its
    // format constraint — both are non-streaming, but only one asks for a
    // `verdict` field.
    const isVerify = payload.format?.properties?.verdict !== undefined
    if (isVerify) {
      return new Response(
        JSON.stringify({ response: verifyReplies.shift() ?? verifyReply('ok', 'All checks pass.') }),
        { status: 200 },
      )
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

async function frames(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text()
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

const SQL = `SELECT SUM(amount) / 100.0 AS total_spent FROM "Transaction" WHERE category = '🛒 Groceries'`

describe('POST /api/chat — Phase A verification gating (ADR-0025)', () => {
  it('an ok verdict narrates normally, with no visible sign of the verifier', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: 100 }], truncated: false })]
    verifyReplies = [verifyReply('ok', 'All three checks pass.')]

    const out = await frames(await ask('How much did I spend on groceries?'))

    expect(out.map((f) => f.type)).toEqual(['sql', 'result', 'token'])
  })

  it('a grounded mismatch verdict declines instead of narrating, and never shows the model\'s reason', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: 100 }], truncated: false })]
    verifyReplies = [verifyReply('mismatch', 'Filter: the question asked about this month, the query has no date filter at all.')]

    const out = await frames(await ask('How much did I spend on groceries this month?'))

    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('unsupported-shape')
    expect(String(out[0].message)).not.toContain('Filter:')
    expect(String(out[0].message)).not.toContain('the query has no date filter at all')
  })

  it('an out-of-scope verdict declines with that reason, and never shows the model\'s reason', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: 100 }], truncated: false })]
    verifyReplies = [verifyReply('out-of-scope', 'No table in this ledger records loan interest rates.')]

    const out = await frames(await ask('What interest rate am I paying on my loan?'))

    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('no-answer')
    expect(out[0].reason).toBe('out-of-scope')
    expect(String(out[0].message)).not.toContain('interest rates')
  })

  it('an ungrounded mismatch (no Filter:/Label:/Shape: tag) is downgraded to ok and narrates', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: 100 }], truncated: false })]
    verifyReplies = [verifyReply('mismatch', 'This just looks off to me.')]

    const out = await frames(await ask('How much did I spend on groceries?'))

    expect(out.map((f) => f.type)).toEqual(['sql', 'result', 'token'])
  })

  it('a verifier transport failure fails open — the turn narrates anyway', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: 100 }], truncated: false })]

    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body)
      if (payload.stream) return narrationStream()
      const isVerify = payload.format?.properties?.verdict !== undefined
      if (isVerify) throw new Error('connection refused')
      return new Response(JSON.stringify({ response: sqlReplies.shift() ?? 'SELECT 1' }), { status: 200 })
    })

    const out = await frames(await ask('How much did I spend on groceries?'))

    expect(out.map((f) => f.type)).toEqual(['sql', 'result', 'token'])
    expect(verdictCreateCalls).toHaveLength(1)
    expect(verdictCreateCalls[0].verdict).toBe('unusable')
  })

  it('writes exactly one ChatVerdict row per turn that reaches the verifier, before narration', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: 100 }], truncated: false })]
    verifyReplies = [verifyReply('ok', 'All checks pass.')]

    await ask('How much did I spend on groceries?')

    expect(verdictCreateCalls).toHaveLength(1)
    expect(verdictCreateCalls[0]).toMatchObject({
      question: 'How much did I spend on groceries?',
      sql: SQL,
      rowCount: 1,
      truncated: false,
      verdict: 'ok',
      reason: 'All checks pass.',
      model: 'qwen2.5:32b',
    })
    expect(typeof verdictCreateCalls[0].latencyMs).toBe('number')
  })

  it('writes no ChatVerdict row when an earlier guard refuses before the verifier runs', async () => {
    sqlReplies = [`SELECT openingBalance AS total_balance FROM Account`]

    await ask('What is my net worth composed of?')

    expect(verdictCreateCalls).toHaveLength(0)
  })

  it('writes no ChatVerdict row when the query matches no data — the no-data check runs first', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: null }], truncated: false })]

    await ask('How much did I spend on groceries?')

    expect(verdictCreateCalls).toHaveLength(0)
  })

  it('a failure recording the verdict does not fail the turn', async () => {
    sqlReplies = [SQL]
    queryResults = [() => ({ rows: [{ total_spent: 100 }], truncated: false })]
    verifyReplies = [verifyReply('ok', 'All checks pass.')]

    const { prisma } = await import('@/lib/prisma')
    vi.spyOn(prisma.chatVerdict, 'create').mockRejectedValueOnce(new Error('disk full'))

    const out = await frames(await ask('How much did I spend on groceries?'))

    expect(out.map((f) => f.type)).toEqual(['sql', 'result', 'token'])
  })
})
