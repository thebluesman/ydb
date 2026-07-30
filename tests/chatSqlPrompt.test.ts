import { describe, it, expect } from 'vitest'
import { buildSqlSystemPrompt, isoDate, mostRecentMonthYm } from '@/lib/chatSqlPrompt'

// Fixed reference point: the date of the reported bug. The model resolved
// "June" to 2023-06 on this day.
const JUL_29_2026 = new Date('2026-07-29T10:15:00.000Z')

describe('mostRecentMonthYm', () => {
  it('resolves an earlier month to the current year', () => {
    expect(mostRecentMonthYm(JUL_29_2026, 6)).toBe('2026-06')
    expect(mostRecentMonthYm(JUL_29_2026, 1)).toBe('2026-01')
  })

  it('resolves a later month to the previous year', () => {
    expect(mostRecentMonthYm(JUL_29_2026, 8)).toBe('2025-08')
    expect(mostRecentMonthYm(JUL_29_2026, 12)).toBe('2025-12')
  })

  it('treats the current month as already occurred, even partway through', () => {
    expect(mostRecentMonthYm(JUL_29_2026, 7)).toBe('2026-07')
    expect(mostRecentMonthYm(new Date('2026-07-01T00:00:00.000Z'), 7)).toBe('2026-07')
  })

  it('zero-pads single-digit months', () => {
    expect(mostRecentMonthYm(JUL_29_2026, 3)).toBe('2026-03')
  })

  it('rolls the year back correctly in January', () => {
    const jan = new Date('2026-01-05T00:00:00.000Z')
    expect(mostRecentMonthYm(jan, 1)).toBe('2026-01')
    expect(mostRecentMonthYm(jan, 2)).toBe('2025-02')
    expect(mostRecentMonthYm(jan, 12)).toBe('2025-12')
  })

  it('uses UTC, not the host timezone', () => {
    // 2026-08-01T00:30Z is still July 31 in any negative-offset zone. The
    // answer must follow UTC so it agrees with SQLite's date('now').
    const justAfterUtcMonthRollover = new Date('2026-08-01T00:30:00.000Z')
    expect(mostRecentMonthYm(justAfterUtcMonthRollover, 8)).toBe('2026-08')
  })
})

describe('isoDate', () => {
  it('returns a UTC YYYY-MM-DD', () => {
    expect(isoDate(JUL_29_2026)).toBe('2026-07-29')
  })
})

describe('buildSqlSystemPrompt', () => {
  const prompt = buildSqlSystemPrompt(JUL_29_2026)

  it("states the server-supplied current date", () => {
    expect(prompt).toContain("Today's date is 2026-07-29")
  })

  it('tells the model how to resolve a bare month name', () => {
    expect(prompt).toContain("\"June\" means '2026-06'")
  })

  it('carries a worked bare-month example using a literal YYYY-MM, not date(\'now\')', () => {
    expect(prompt).toContain("strftime('%Y-%m', date) = '2026-06'")
  })

  it('keeps the relative-date examples resolving live in SQLite', () => {
    // The date('now') rule is untouched by the date injection: these work
    // regardless of when the query runs and must not become literals.
    expect(prompt).toContain("strftime('%Y-%m', date('now','-1 month'))")
    expect(prompt).toContain("strftime('%Y', date('now'))")
  })

  it('contains no hardcoded year other than ones derived from the given date', () => {
    const years = [...prompt.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0])
    const allowed = new Set(['2026', '2025', '2024'])  // current, prior, and the schema's example date
    expect(years.filter((y) => !allowed.has(y))).toEqual([])
  })

  it('moves with the calendar rather than baking in a build-time year', () => {
    const laterPrompt = buildSqlSystemPrompt(new Date('2027-02-14T00:00:00.000Z'))
    expect(laterPrompt).toContain("Today's date is 2027-02-14")
    // February 2027 -> the most recent June is 2026-06.
    expect(laterPrompt).toContain("strftime('%Y-%m', date) = '2026-06'")
  })

  it('still carries the invariants the schema rules depend on', () => {
    expect(prompt).toContain('"Transaction"')
    expect(prompt).toContain('INTEGER number of cents')
    expect(prompt).toContain("status IN ('committed','reconciled')")
    expect(prompt).toContain('LIMIT 200')
    // Blocked tables must stay listed.
    expect(prompt).toContain('Setting, ChatSession, ChatMessage, Budget, VendorRule')
  })

  it('defaults to the real current date when called with no argument', () => {
    expect(buildSqlSystemPrompt()).toContain(`Today's date is ${isoDate(new Date())}`)
  })

  // ADR-0011. The prompt rule is the fix; the route check is the backstop. If
  // rejections stay common in practice, this few-shot is what to change.
  describe('compound-SELECT rule (ADR-0011)', () => {
    it('states the ban explicitly', () => {
      expect(prompt).toContain('NEVER use UNION or UNION ALL')
    })

    it('explains why, in terms of the label collapse', () => {
      expect(prompt).toMatch(/FIRST branch only/)
      expect(prompt).toMatch(/both rows labelled total_expenses/i)
    })

    it('tells the model the server rejects it rather than running it', () => {
      expect(prompt).toMatch(/rejects any query containing UNION/i)
    })

    it('carries a multi-figure few-shot using conditional aggregates in one row', () => {
      expect(prompt).toContain('AS total_expenses, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income')
    })

    it('never demonstrates the banned shape in an example', () => {
      // Few-shot shape beats prose instruction, so a UNION must never appear on
      // an `A:` answer line — only in the prohibition and its commentary.
      const answerLines = prompt.split('\n').filter((l) => l.startsWith('A: '))
      expect(answerLines).not.toHaveLength(0)
      expect(answerLines.filter((l) => /\bUNION\b/i.test(l))).toEqual([])
    })
  })
})
