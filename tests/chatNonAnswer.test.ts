import { describe, expect, it } from 'vitest'
import {
  isNoDataResult,
  isNonAnswerReason,
  noDataMessage,
  NON_ANSWER_HEADLINE,
  NON_ANSWER_REASONS,
  nonAnswerFrame,
  nonAnswerResponse,
} from '@/lib/chatNonAnswer'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0014: a non-answer is a first-class chat response.
//
// The load-bearing case is isNoDataResult. The bug it exists to kill is
// `SELECT SUM(amount) ... WHERE category = 'Grocries'` returning
// [{ total: null }] and narration rendering that as "you spent nothing on
// groceries last month" — a wrong answer, not a non-answer. The inverse
// matters just as much: a real COUNT(*) of 0 is a correct answer and must
// still be narrated.
// ─────────────────────────────────────────────────────────────────────────────

describe('isNoDataResult', () => {
  it('treats zero rows as no data', () => {
    expect(isNoDataResult([])).toBe(true)
  })

  it('treats a single all-NULL aggregate row as no data', () => {
    expect(isNoDataResult([{ total: null }])).toBe(true)
    expect(isNoDataResult([{ total: null, category: null }])).toBe(true)
  })

  it('does NOT treat a genuine zero as no data', () => {
    expect(isNoDataResult([{ total: 0 }])).toBe(false)
    expect(isNoDataResult([{ count: 0 }])).toBe(false)
  })

  it('does not treat a partially-NULL row as no data', () => {
    expect(isNoDataResult([{ category: 'Groceries', total: null }])).toBe(false)
  })

  it('does not treat real rows as no data', () => {
    expect(isNoDataResult([{ total: -1234 }, { total: 5 }])).toBe(false)
  })

  it('treats an empty string or falsy-but-present value as data', () => {
    expect(isNoDataResult([{ description: '' }])).toBe(false)
    expect(isNoDataResult([{ flag: false }])).toBe(false)
  })
})

describe('reason codes', () => {
  it('accepts exactly the four ADR-0014 reasons', () => {
    expect([...NON_ANSWER_REASONS]).toEqual([
      'out-of-scope',
      'no-data',
      'unsupported-shape',
      'budget-exhausted',
    ])
  })

  it('validates reasons and rejects anything else', () => {
    for (const r of NON_ANSWER_REASONS) expect(isNonAnswerReason(r)).toBe(true)
    expect(isNonAnswerReason('nope')).toBe(false)
    expect(isNonAnswerReason(undefined)).toBe(false)
    expect(isNonAnswerReason(null)).toBe(false)
    expect(isNonAnswerReason(42)).toBe(false)
  })

  it('has a headline for every reason, so adding one is a one-line change on both sides', () => {
    for (const r of NON_ANSWER_REASONS) expect(NON_ANSWER_HEADLINE[r]).toBeTruthy()
    expect(Object.keys(NON_ANSWER_HEADLINE).sort()).toEqual([...NON_ANSWER_REASONS].sort())
  })
})

describe('nonAnswerFrame', () => {
  it('carries the attempted SQL — a non-answer shows its work', () => {
    const frame = nonAnswerFrame('no-data', 'nothing matched', 'SELECT 1')
    expect(frame).toEqual({ type: 'no-answer', reason: 'no-data', message: 'nothing matched', sql: 'SELECT 1' })
  })

  it('omits sql entirely when there was no query to show', () => {
    expect(nonAnswerFrame('out-of-scope', 'declined')).toEqual({
      type: 'no-answer',
      reason: 'out-of-scope',
      message: 'declined',
    })
  })
})

describe('nonAnswerResponse', () => {
  it('is a successful NDJSON response, not an HTTP error', async () => {
    const res = nonAnswerResponse(nonAnswerFrame('no-data', 'nothing matched', 'SELECT 1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const body = await res.text()
    expect(body.endsWith('\n')).toBe(true)
    // One frame per line: parses with the same reader the streamed path uses.
    const lines = body.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'no-answer', reason: 'no-data' })
  })
})

describe('noDataMessage', () => {
  it('names the question, distinguishes itself from zero, and points at the query', () => {
    const msg = noDataMessage('How much did I spend on groceries last month?')
    expect(msg).toContain('How much did I spend on groceries last month?')
    expect(msg).toContain('not the same as a total of zero')
    expect(msg.toLowerCase()).toContain('query')
  })

  it('bounds an oversized question so the refusal stays readable', () => {
    expect(noDataMessage('x'.repeat(1000))).toContain('x'.repeat(200) + '"')
  })
})
