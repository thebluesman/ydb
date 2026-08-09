import { describe, it, expect } from 'vitest'
import { buildSqlSystemPrompt, isoDate, mostRecentMonthYm, weekRange } from '@/lib/chatSqlPrompt'

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

describe('weekRange', () => {
  // The reported bug: "What transactions were on my salary account this week?"
  // generated a trailing `date('now','-7 days')` window and the Phase A verifier
  // flagged it as a mismatch (ChatVerdict, 2026-08-09). Nothing defined a week,
  // so these pin what one is before the prompt can teach it.

  it('starts the week on Monday and ends it half-open on the next Monday', () => {
    // 2026-07-29 is a Wednesday.
    expect(weekRange(JUL_29_2026)).toEqual({ start: '2026-07-27', endExclusive: '2026-08-03' })
  })

  it('is correct ON the Monday itself', () => {
    // The trap in `date('now','weekday 1','-7 days')`: SQLite's weekday modifier
    // is a no-op when the date is already that weekday, so the -7 days is not
    // cancelled and the window slides a whole week back. One day in seven the
    // answer is confidently about the wrong week.
    const monday = new Date('2026-08-03T00:00:00.000Z')
    expect(monday.getUTCDay()).toBe(1)
    expect(weekRange(monday).start).toBe('2026-08-03')
  })

  it('is correct on the Sunday that ends the week', () => {
    // The date the mismatched verdict was recorded, and the mirror of the case
    // above for a Sunday-start convention.
    const sunday = new Date('2026-08-09T18:00:00.000Z')
    expect(sunday.getUTCDay()).toBe(0)
    expect(weekRange(sunday)).toEqual({ start: '2026-08-03', endExclusive: '2026-08-10' })
  })

  it('counts weeksAgo back a whole week at a time', () => {
    expect(weekRange(JUL_29_2026, 1)).toEqual({ start: '2026-07-20', endExclusive: '2026-07-27' })
    expect(weekRange(JUL_29_2026, 2).start).toBe('2026-07-13')
  })

  it('abuts: last week ends exactly where this week starts', () => {
    expect(weekRange(JUL_29_2026, 1).endExclusive).toBe(weekRange(JUL_29_2026, 0).start)
  })

  it('crosses a year boundary without special-casing it', () => {
    // 2026-01-01 is a Thursday, so its week began in the previous year. This is
    // the case strftime('%W', ...) arithmetic gets wrong: week 00 is the days
    // before the first Monday, and "last week" by subtracting 1 breaks outright.
    const newYearsDay = new Date('2026-01-01T00:00:00.000Z')
    expect(weekRange(newYearsDay)).toEqual({ start: '2025-12-29', endExclusive: '2026-01-05' })
    expect(weekRange(newYearsDay, 1).start).toBe('2025-12-22')
  })

  it('uses UTC, not the host timezone', () => {
    // 2026-08-03T00:30Z is still Sunday Aug 2 in any negative-offset zone. The
    // answer must follow UTC so it agrees with SQLite's date('now'), the same
    // reason mostRecentMonthYm does.
    const justAfterUtcWeekRollover = new Date('2026-08-03T00:30:00.000Z')
    expect(weekRange(justAfterUtcWeekRollover).start).toBe('2026-08-03')
  })

  it('is a pure function of the instant, not of the time of day', () => {
    expect(weekRange(new Date('2026-07-29T00:00:00.000Z'))).toEqual(
      weekRange(new Date('2026-07-29T23:59:59.999Z')),
    )
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
    expect(prompt).toContain('Setting, ChatSession, ChatMessage, ChatVerdict, Budget, VendorRule')
  })

  it('defaults to the real current date when called with no argument', () => {
    expect(buildSqlSystemPrompt()).toContain(`Today's date is ${isoDate(new Date())}`)
  })

  // Both fixes below came out of real ChatVerdict rows (2026-08-09), not from
  // coverage — the same way every prior prompt bug in this initiative surfaced.
  describe('week-boundary semantics', () => {
    const answerLines = prompt.split('\n').filter((l) => l.startsWith('A: '))

    it('defines "this week" as the calendar week, not the last 7 days', () => {
      expect(prompt).toMatch(/"this week" and "last week" mean the CALENDAR week, Monday to Sunday/)
      expect(prompt).toContain('not the last 7 days')
    })

    it('supplies both weeks as server-computed literals', () => {
      // JUL_29_2026 is a Wednesday: this week is Mon 07-27, last week Mon 07-20.
      expect(prompt).toContain(`date >= '2026-07-27' AND date < '2026-08-03'`)
      expect(prompt).toContain(`date >= '2026-07-20' AND date < '2026-07-27'`)
    })

    it('names both unsafe SQLite idioms so neither is reinvented', () => {
      expect(prompt).toContain(`date('now','weekday 0','-7 days')`)
      expect(prompt).toContain(`strftime('%W', date)`)
    })

    it('carries a worked example built from the supplied literals', () => {
      const weekExamples = answerLines.filter((l) => l.includes(`date >= '2026-07-27'`))
      expect(weekExamples).toHaveLength(1)
      // And it is a properly guarded spend aggregate, not a bare date filter.
      expect(weekExamples[0]).toContain('SUM(-amount) / 100.0 AS total_spent')
    })

    it('never demonstrates a trailing window as though it were a calendar week', () => {
      // Few-shot shape beats prose: an `A:` line resolving "this week" to
      // date('now','-7 days') would teach exactly the bug this rule fixes.
      expect(answerLines.filter((l) => /date\('now','-7 days'\)/.test(l))).toEqual([])
    })

    it('keeps a genuinely rolling window rolling', () => {
      // The rule must not over-correct: "the last 7 days" is still trailing.
      expect(prompt).toMatch(/"The last 7 days" is NOT "this week"/)
    })
  })

  describe('the income example carries the reimbursement guard', () => {
    // A real "What was my total income last month?" turn generated SQL without
    // it and the Phase A verifier flagged the mismatch. The example was the only
    // flow aggregate in the prompt missing the clause, and few-shot shape beats
    // prose, so it read as permission to drop it.
    const income = prompt
      .split('\n')
      .filter((l) => l.startsWith('A: ') && /amount > 0/.test(l) && /SUM\(amount\)/.test(l))

    it('finds the income example at all', () => {
      expect(income).toHaveLength(1)
    })

    it('guards it the same way its sibling expense examples are guarded', () => {
      for (const guard of [
        'amount > 0',
        `transactionType != 'transfer'`,
        'parentTransactionId IS NULL',
        'reimbursementTxId IS NULL',
        `status IN ('committed','reconciled')`,
      ]) {
        expect(income[0], guard).toContain(guard)
      }
    })

    it('leaves every flow aggregate in the prompt carrying the guard', () => {
      // The general form of the bug, so a future example cannot reintroduce it
      // somewhere else. Exempt: the transfer-volume example, whose subject is a
      // matched pair, and the row COUNT, which is not a money figure.
      const flowAggregates = prompt
        .split('\n')
        .filter((l) => l.startsWith('A: '))
        .filter((l) => /SUM\s*\(/i.test(l) && !/transactionType = 'transfer'/.test(l))
      expect(flowAggregates.length).toBeGreaterThanOrEqual(9)
      for (const sql of flowAggregates) {
        expect(sql, 'reimbursement guard missing').toContain('reimbursementTxId IS NULL')
      }
    })
  })

  // ADR-0011. The prompt rule is the fix; the route check is the backstop. If
  // rejections stay common in practice, this few-shot is what to change.
  describe('compound-SELECT rule (ADR-0011)', () => {
    it('states the ban explicitly, over all three compound operators', () => {
      // Widened by ADR-0011's 2026-07-30 addendum: the first-branch naming rule
      // is a property of compound SELECTs, so naming only UNION left INTERSECT
      // and EXCEPT as unbanned routes to the same wrong answer.
      expect(prompt).toContain('NEVER use UNION, UNION ALL, INTERSECT or EXCEPT')
    })

    it('explains why, in terms of the label collapse', () => {
      expect(prompt).toMatch(/FIRST branch only/)
      expect(prompt).toMatch(/both rows labelled total_expenses/i)
    })

    it('tells the model the server rejects it rather than running it', () => {
      expect(prompt).toMatch(/rejects any query containing a compound SELECT/i)
    })

    it('carries a multi-figure few-shot using conditional aggregates in one row', () => {
      expect(prompt).toContain('AS total_expenses, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income')
    })

    it('never demonstrates the banned shape in an example', () => {
      // Few-shot shape beats prose instruction, so no compound operator may
      // appear on an `A:` answer line — only in the prohibition and its
      // commentary.
      const answerLines = prompt.split('\n').filter((l) => l.startsWith('A: '))
      expect(answerLines).not.toHaveLength(0)
      expect(answerLines.filter((l) => /\b(UNION|INTERSECT|EXCEPT)\b/i.test(l))).toEqual([])
    })
  })
})
