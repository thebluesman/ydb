import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Route-level coverage of ADR-0027 in POST /api/chat.
//
// The load-bearing property is "once, to one binding": narration and the
// `result` frame are handed the SAME numbers, so the sentence and the table
// cannot disagree about a sign — the live bug was "You spent 3654.43 AED"
// printed directly above a card reading -3,654.43.
//
// The second property is POSITION. Sign normalization runs AFTER the Phase A
// verifier and after `signPromiseViolation`: those judge what the SQL actually
// computed, and handing them a sign the server invented would make them grade
// the server's arithmetic instead of the model's.
//
// Same mocking pattern as tests/chatVerificationRoute.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['✈️ Travel', '🛒 Groceries', '🏠 Rent']
const ACCOUNTS = ['ADCB Current', 'Emirates NBD Savings']

let queryResults: (() => { rows: unknown[]; truncated: boolean })[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: { findFirst: async () => ({ value: 'AED' }) },
    transaction: { findMany: async () => CATEGORIES.map((category) => ({ category })) },
    account: { findMany: async () => ACCOUNTS.map((name) => ({ name })) },
    chatVerdict: { create: async () => ({ id: 1 }) },
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
let verifyReplies: string[] = []
let narrationPrompts: string[] = []
let verifyPrompts: string[] = []

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
  sqlReplies = []
  verifyReplies = []
  narrationPrompts = []
  verifyPrompts = []

  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body)
    if (payload.stream) {
      narrationPrompts.push(payload.prompt)
      return narrationStream()
    }
    const isVerify = payload.format?.properties?.verdict !== undefined
    if (isVerify) {
      verifyPrompts.push(payload.prompt)
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

const FILTERS =
  `transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL ` +
  `AND status IN ('committed','reconciled')`

/**
 * A direction-pinned shape: `WHERE amount < 0` plus a plain `total` alias.
 * NOT the literal live-bug query (see UNPINNED_SQL below for that) — this is
 * the shape the classifier's WHERE-pin trigger targets, used across most of
 * this file's tests for that reason.
 */
const PINNED_SQL =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
  `WHERE amount < 0 AND category = '🛒 Groceries' AND ${FILTERS}`

/** No direction filter and no negation — the deferred signed-answer shape. */
const NET_SQL =
  `SELECT SUM(amount) / 100.0 AS net FROM "Transaction" WHERE ${FILTERS}`

/**
 * The ACTUAL live-bug query, reported 2026-08-04: a category-filtered spend
 * total with neither trigger — no negation, no zero-comparison on `amount`
 * anywhere in the WHERE. `@tech-lead`'s PR #54 review flagged that this
 * fixture set never actually reproduced the reported shape, only the
 * WHERE-pinned one, and that PINNED_SQL's docstring wrongly claimed it did.
 * `moneyKeys` still fixes this row's missing currency symbol (ADR-0023's
 * classifier bug); `magnitudeKeys` correctly does NOT fire, because a bare
 * `WHERE category = ...` cannot tell the classifier every surviving row is an
 * outflow. This residual gap is real and open — see docs/architecture.md —
 * fixed at the SQL-prompt level (teaching this shape to negate), not here.
 */
const UNPINNED_SQL =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
  `WHERE category = '🛒 Groceries' AND ${FILTERS}`

function resultFrame(out: Record<string, unknown>[]): Record<string, unknown> {
  const frame = out.find((f) => f.type === 'result')
  if (!frame) throw new Error('no result frame in the stream')
  return frame
}

describe('POST /api/chat — display sign (ADR-0027)', () => {
  it('a WHERE-pinned outflow total displays positive, in the frame and in the narration prompt alike', async () => {
    sqlReplies = [PINNED_SQL]
    queryResults = [() => ({ rows: [{ total: -3654.43 }], truncated: false })]

    const out = await frames(await ask('How much did I spend on groceries last month?'))
    const frame = resultFrame(out)

    expect(frame.rows).toEqual([{ total: 3654.43 }])
    expect(narrationPrompts[0]).toContain('3654.43')
    expect(narrationPrompts[0]).not.toContain('-3654.43')
  })

  it('the frame and the narration prompt carry byte-identical rows — they cannot disagree', async () => {
    sqlReplies = [PINNED_SQL]
    queryResults = [() => ({ rows: [{ total: -3654.43 }], truncated: false })]

    const out = await frames(await ask('How much did I spend on groceries last month?'))

    expect(narrationPrompts[0]).toContain(JSON.stringify(resultFrame(out).rows, null, 2))
  })

  it('the same total is now a money column, so the card renders with a currency (ADR-0027 correcting ADR-0023)', async () => {
    sqlReplies = [PINNED_SQL]
    queryResults = [() => ({ rows: [{ total: -3654.43 }], truncated: false })]

    const frame = resultFrame(await frames(await ask('How much did I spend on groceries last month?')))

    expect(frame.columns).toEqual([{ key: 'total', label: 'total', kind: 'money' }])
    expect(frame.currency).toBe('AED')
  })

  it('an unpinned net total keeps its sign in both places', async () => {
    sqlReplies = [NET_SQL]
    queryResults = [() => ({ rows: [{ net: -120.5 }], truncated: false })]

    const out = await frames(await ask('What was my net cash flow last month?'))

    expect(resultFrame(out).rows).toEqual([{ net: -120.5 }])
    expect(narrationPrompts[0]).toContain('-120.5')
  })

  it('the actual reported live-bug query still displays signed — a real, open, documented gap', async () => {
    // UNPINNED_SQL is the literal query from the reported bug: a
    // category-filtered spend total with no negation and no zero-comparison
    // anywhere in WHERE, so magnitudeKeys correctly does not fire (the
    // classifier cannot tell from `WHERE category = ...` alone that every
    // surviving row is an outflow). moneyKeys DOES fire, so the currency
    // symbol appears even though the sign does not go away — a real, partial
    // fix, not the illusion of a complete one. Closing this fully is a
    // SQL-prompt change (teach this shape to negate, same as the grouped
    // examples already do), tracked as a follow-up, not done here.
    sqlReplies = [UNPINNED_SQL]
    queryResults = [() => ({ rows: [{ total: -3654.43 }], truncated: false })]

    const out = await frames(await ask('How much did I spend on groceries last month?'))
    const frame = resultFrame(out)

    expect(frame.rows).toEqual([{ total: -3654.43 }])
    expect(frame.columns).toEqual([{ key: 'total', label: 'total', kind: 'money' }])
    expect(narrationPrompts[0]).toContain('-3654.43')
  })

  it('the verifier sees the query\'s own signs, not the display ones', async () => {
    // Position check: `applyMoneySign` runs after `verifyResult`. The verifier
    // is asked whether the SQL answers the question, so it must be shown what
    // the SQL computed.
    sqlReplies = [PINNED_SQL]
    queryResults = [() => ({ rows: [{ total: -3654.43 }], truncated: false })]

    await ask('How much did I spend on groceries last month?')

    expect(verifyPrompts[0]).toContain('-3654.43')
  })

  it('a mismatch verdict declines before any display row is built — no result frame at all', async () => {
    sqlReplies = [PINNED_SQL]
    queryResults = [() => ({ rows: [{ total: -3654.43 }], truncated: false })]
    verifyReplies = [verifyReply('mismatch', 'Filter: the question asked about last month, the query has no date filter.')]

    const out = await frames(await ask('How much did I spend on groceries last month?'))

    expect(out.map((f) => f.type)).toEqual(['no-answer'])
    expect(narrationPrompts).toHaveLength(0)
  })

  it('an out-of-scope verdict likewise never reaches display-row construction', async () => {
    sqlReplies = [PINNED_SQL]
    queryResults = [() => ({ rows: [{ total: -3654.43 }], truncated: false })]
    verifyReplies = [verifyReply('out-of-scope', 'No table in this ledger records that.')]

    const out = await frames(await ask('How much did I spend on groceries last month?'))

    expect(out.map((f) => f.type)).toEqual(['no-answer'])
    expect(narrationPrompts).toHaveLength(0)
  })

  it('a negative "spent" alias is still refused by signPromiseViolation — the sign step does not launder it', async () => {
    // `signPromiseViolation` runs BEFORE the sign step and reads the alias
    // convention (ADR-0025 addendum). ADR-0027 explicitly leaves that check in
    // place; a magnitude applied first would have silently satisfied it.
    sqlReplies = [
      `SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction" ` +
      `WHERE amount < 0 AND category = '🛒 Groceries' AND ${FILTERS}`,
    ]
    queryResults = [() => ({ rows: [{ total_spent: -3654.43 }], truncated: false })]

    const out = await frames(await ask('How much did I spend on groceries last month?'))

    expect(out.map((f) => f.type)).toEqual(['no-answer'])
    expect(out[0].reason).toBe('unsupported-shape')
  })

  it('a mixed transaction list keeps its per-row directions', async () => {
    sqlReplies = [
      `SELECT date, description, amount / 100.0 AS amount FROM "Transaction" ` +
      `WHERE ${FILTERS} ORDER BY date DESC LIMIT 3`,
    ]
    queryResults = [() => ({
      rows: [
        { date: '2026-07-14', description: 'Salary', amount: 12000 },
        { date: '2026-07-13', description: 'Carrefour', amount: -220.5 },
        { date: '2026-07-12', description: 'Coffee', amount: -12.5 },
      ],
      truncated: false,
    })]

    const frame = resultFrame(await frames(await ask('Show me my last few transactions')))

    expect(frame.rows).toEqual([
      { date: '2026-07-14', description: 'Salary', amount: 12000 },
      { date: '2026-07-13', description: 'Carrefour', amount: -220.5 },
      { date: '2026-07-12', description: 'Coffee', amount: -12.5 },
    ])
  })
})
