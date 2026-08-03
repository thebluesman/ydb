import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level wiring for [chat-model] PR 2's two prompt-side outputs:
//
//   output 16 — the configured narration voice reaches the system prompt;
//   output  5 — a caveat is appended to the turn's prompt only when the
//               classifier finds one, and never inside the data fence.
//
// Same mocking pattern as the other chat route suites — '@/lib/prisma' replaced
// wholesale, fake Ollama on global.fetch — because what is being pinned is what
// the route SENDS, not what the model returns.
//
// Neither output may touch the wire contract, so the frame assertions at the
// bottom are part of the point: ADR-0023's `result` frame is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', '🏠 Rent']
const ACCOUNTS = ['ADCB Current']

let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []
let narrationStyle = 'direct'

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

vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: async () => ({
    ollamaUrl: 'http://ollama.test',
    sqlModel: 'coder-model:7b',
    narrationModel: 'prose-model:3b',
    narrationStyle,
  }),
}))

const { POST } = await import('@/app/api/chat/route')
const { CONFIDENCE_RULE } = await import('@/lib/chatKnowledge')

type Payload = { model: string; stream: boolean; system?: string; prompt?: string }
let payloads: Payload[] = []
let sqlReplies: string[] = []

// A closed month, fully scoped: the answer that must NOT be hedged.
const CLOSED_MONTH_SQL =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
  `WHERE category = '🛒 Groceries' AND date >= '2020-01-01' AND date < '2020-02-01' LIMIT 200`

const CLOSED_QUESTION = 'How much did I spend on groceries in January 2020?'

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
  narrationStyle = 'direct'
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    payloads.push(payload)
    if (payload.stream) return narrationStream()
    return new Response(JSON.stringify({ response: sqlReplies.shift() ?? CLOSED_MONTH_SQL }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function ask(question: string = CLOSED_QUESTION): Promise<string> {
  const res = await POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  }))
  return res.text()
}

const narration = () => payloads.find((p) => p.stream)!

describe('POST /api/chat — narration voice (output 16)', () => {
  it('ships the direct persona by default', async () => {
    await ask()
    expect(narration().system).toContain('You are a helpful financial assistant.')
    expect(narration().system).not.toContain('financial coach')
  })

  it('swaps in the coaching persona when configured', async () => {
    narrationStyle = 'coaching'
    await ask()
    expect(narration().system).toContain('supportive financial coach')
    expect(narration().system).not.toContain('You are a helpful financial assistant.')
  })

  // The voice is presentation. Everything that governs the numbers — the units
  // rule (ADR-0020) and the confidence rule — is identical under both.
  it('leaves the operative rules untouched under either voice', async () => {
    await ask()
    const direct = narration().system!
    payloads = []
    narrationStyle = 'coaching'
    await ask()
    const coaching = narration().system!
    for (const system of [direct, coaching]) {
      expect(system).toContain('already in AED currency units')
      expect(system.endsWith(CONFIDENCE_RULE)).toBe(true)
    }
  })

  // The SQL half of the turn has nothing to do with voice, and the narration
  // persona must not leak into the prompt that generates queries.
  it('never puts the persona in the SQL prompt', async () => {
    narrationStyle = 'coaching'
    await ask()
    const sqlCall = payloads.find((p) => !p.stream)!
    expect(sqlCall.system).not.toContain('financial coach')
  })
})

describe('POST /api/chat — confidence qualification (output 5)', () => {
  it('appends nothing for a fully-scoped closed-period total', async () => {
    await ask()
    expect(narration().prompt).not.toContain('Caveat to state')
  })

  it('appends the partial-period caveat when the window is still open', async () => {
    const thisMonth = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE date >= date('now', 'start of month') LIMIT 200`
    sqlReplies = [thisMonth]
    await ask('How much have I spent this month?')
    expect(narration().prompt).toContain('Caveat to state')
    expect(narration().prompt).toContain('still in progress')
  })

  it('appends the truncation caveat when rows were cut', async () => {
    queryResults = [() => ({
      rows: Array.from({ length: 40 }, (_, i) => ({ category: `c${i}`, total: i + 1 })),
      truncated: false,
    })]
    sqlReplies = [
      `SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" GROUP BY category LIMIT 200`,
    ]
    await ask('What are my top categories?')
    expect(narration().prompt).toContain('more rows matched')
  })

  // The caveat is an instruction, and the region between the data markers is
  // declared to be verbatim data that must never be read as instruction. Putting
  // one inside the other would undercut exactly that claim.
  it('places the caveat after the data fence, never inside it', async () => {
    sqlReplies = [
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE date >= date('now', '-7 days') LIMIT 200`,
    ]
    await ask('What have I spent so far this week?')
    const prompt = narration().prompt!
    expect(prompt.indexOf('Caveat to state')).toBeGreaterThan(prompt.indexOf('QUERY_RESULT_END>>>'))
  })

  it('does not put the caveat in the SQL prompt or the system prompt', async () => {
    sqlReplies = [
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE date >= date('now', '-7 days') LIMIT 200`,
    ]
    await ask('What have I spent so far this week?')
    expect(narration().system).not.toContain('Caveat to state')
    expect(payloads.find((p) => !p.stream)!.system).not.toContain('Caveat to state')
  })
})

describe('POST /api/chat — the wire contract is untouched', () => {
  it('still emits sql then exactly one result frame, unchanged in shape', async () => {
    narrationStyle = 'coaching'
    const body = await ask()
    const frames = body.trim().split('\n').map((l) => JSON.parse(l))
    expect(frames[0].type).toBe('sql')
    expect(frames[1].type).toBe('result')
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    expect(Object.keys(frames[1]).sort()).toEqual(
      ['columns', 'currency', 'present', 'rows', 'truncated', 'type'],
    )
    expect(frames.some((f) => f.type === 'token')).toBe(true)
  })
})
