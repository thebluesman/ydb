import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of the sqlModel / narrationModel split ([chat-perf]) in
// POST /api/chat: the two halves of a turn are dispatched to the two configured
// models, and both requests pin the model resident with keep_alive.
//
// Same mocking pattern as the other chat route suites — '@/lib/prisma' replaced
// wholesale, fake Ollama on global.fetch — since the point is what the route
// sends, not what the model returns.
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
    if (!next) return { rows: [{ total: 42.5 }], truncated: false }
    return next()
  },
}))

// The whole point of the split is that these two can differ, so the fixture
// makes them differ — identical values would pass even if the route still drove
// both calls off one setting.
vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: async () => ({
    ollamaUrl: 'http://ollama.test',
    sqlModel: 'coder-model:7b',
    narrationModel: 'prose-model:3b',
  }),
}))

const { POST } = await import('@/app/api/chat/route')

type Payload = { model: string; stream: boolean; keep_alive?: string; options: Record<string, unknown> }
let payloads: Payload[] = []
let sqlReplies: string[] = []

const GROCERIES_SQL =
  `SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" ` +
  `WHERE category = '🛒 Groceries' GROUP BY category LIMIT 200`

const QUESTION = 'How much did I spend on groceries last month?'

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
  payloads = []
  queryResults = []
  sqlReplies = []
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    payloads.push(payload)
    if (payload.stream) return narrationStream()
    return new Response(JSON.stringify({ response: sqlReplies.shift() ?? GROCERIES_SQL }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Ask, and drain the stream so the narration call has certainly been made. */
async function ask(question: string = QUESTION): Promise<void> {
  const res = await POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  }))
  await res.text()
}

const sqlCalls = () => payloads.filter((p) => !p.stream)
const narrationCalls = () => payloads.filter((p) => p.stream)

describe('POST /api/chat — sqlModel / narrationModel split', () => {
  it('sends SQL generation and Phase A verification to sqlModel, narration to narrationModel', async () => {
    await ask()

    // SQL generation, Phase A verification (ADR-0025 — runs on sqlModel), narration.
    expect(payloads).toHaveLength(3)

    const [sqlCall, verifyCall, narrationCall] = payloads
    expect(sqlCall.stream).toBe(false)
    expect(sqlCall.model).toBe('coder-model:7b')
    expect(verifyCall.stream).toBe(false)
    expect(verifyCall.model).toBe('coder-model:7b')
    expect(narrationCall.stream).toBe(true)
    expect(narrationCall.model).toBe('prose-model:3b')
  })

  // Ollama's default 5-minute idle unload is per-runner, so with two different
  // models a turn can find its second model cold. keep_alive on every call is
  // the mitigation; a missing one on any is the stall coming back.
  it('pins all three calls resident with keep_alive', async () => {
    await ask()

    expect(payloads).toHaveLength(3)
    for (const payload of payloads) expect(payload.keep_alive).toBeTruthy()
    expect(new Set(payloads.map((p) => p.keep_alive)).size).toBe(1)
  })

  // keep_alive is a top-level request field. Ollama accepts it nowhere else —
  // tucked inside `options` it is ignored silently, which would look exactly
  // like this test passing.
  it('sends keep_alive at the top level, not inside options', async () => {
    await ask()

    for (const payload of payloads) {
      expect(payload.options).not.toHaveProperty('keep_alive')
    }
  })

  // The repair round-trip is a second SQL call, and it must not drift onto the
  // narration model — it is generating SQL, whatever else is true about it.
  // Phase A verification is also a non-streaming call and also belongs on
  // sqlModel (ADR-0025), so it is a third member of this same group, not a
  // separate case.
  it('keeps the repair round-trip, and verification, on sqlModel', async () => {
    queryResults = [
      () => { throw new Error('no such column: bogus') },
      () => ({ rows: [{ total: 42.5 }], truncated: false }),
    ]
    sqlReplies = [GROCERIES_SQL, GROCERIES_SQL]

    await ask()

    expect(sqlCalls()).toHaveLength(3)
    for (const call of sqlCalls()) expect(call.model).toBe('coder-model:7b')
    expect(narrationCalls()).toHaveLength(1)
    expect(narrationCalls()[0].model).toBe('prose-model:3b')
  })
})
