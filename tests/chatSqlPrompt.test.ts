import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { buildSqlSystemPrompt, isoDate, mostRecentMonthYm, weekRange, weekStartExpr } from '@/lib/chatSqlPrompt'

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

describe('weekStartExpr, against real SQLite', () => {
  // Exercised through an actual SQLite engine rather than asserted as a string,
  // because the whole reason this expression exists is that two idioms that
  // "should" have worked did not. The doc comments were not enough evidence for
  // the last two; they are not enough for this one either.
  const db = new Database(':memory:')
  const bucket = (value: string): string =>
    (db.prepare(`SELECT ${weekStartExpr('?')} AS ws`).get(value, value) as { ws: string }).ws

  it('buckets every day of a week onto the same Monday', () => {
    // Mon 2026-07-27 .. Sun 2026-08-02, with a time component like real rows.
    for (const day of ['27', '28', '29', '30', '31']) {
      expect(bucket(`2026-07-${day} 13:45:07.123`)).toBe('2026-07-27')
    }
    expect(bucket('2026-08-01 00:00:00.000')).toBe('2026-07-27')
    expect(bucket('2026-08-02 23:59:59.999')).toBe('2026-07-27')
  })

  it('does NOT slide a Monday row into the previous week', () => {
    // The trap in date(x,'weekday 1','-7 days'): the modifier is a no-op on a
    // date that is already Monday, so the -7 days is not cancelled. One row in
    // seven would land in the wrong bucket, with a plausible total either side.
    expect(bucket('2026-08-03 00:00:00.000')).toBe('2026-08-03')
    const trap = db
      .prepare(`SELECT date(?, 'weekday 1', '-7 days') AS ws`)
      .get('2026-08-03 00:00:00.000') as { ws: string }
    expect(trap.ws).toBe('2026-07-27') // the bug, pinned so the claim stays evidence
  })

  it('crosses a year boundary without a special case', () => {
    // strftime('%W') splits this week across two labels; the day shift does not.
    expect(bucket('2026-01-01 08:00:00.000')).toBe('2025-12-29')
    expect(bucket('2025-12-29 00:00:00.000')).toBe('2025-12-29')
  })

  it('crosses a leap day', () => {
    expect(bucket('2024-02-29 00:00:00.000')).toBe('2024-02-26')
  })

  it('holds over 1500 consecutive days', () => {
    // The general property, rather than the handful of dates someone thought to
    // pick: the bucket is always a Monday, never after the row's own date, and
    // never more than six days before it.
    const rows = db
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 1500),
              d(x) AS (SELECT date('2023-01-01', '+' || n || ' days') || ' 13:45:07.123' FROM seq)
         SELECT COUNT(*) AS total,
                SUM(CASE WHEN strftime('%w', ${weekStartExpr('x')}) != '1' THEN 1 ELSE 0 END) AS notMonday,
                SUM(CASE WHEN julianday(date(x)) - julianday(${weekStartExpr('x')}) NOT BETWEEN 0 AND 6 THEN 1 ELSE 0 END) AS outOfRange
           FROM d`,
      )
      .get() as { total: number; notMonday: number; outOfRange: number }
    expect(rows.total).toBe(1501)
    expect(rows.notMonday).toBe(0)
    expect(rows.outOfRange).toBe(0)
  })

  it('agrees with weekRange, which is the same week boundary computed in TypeScript', () => {
    // The two must not be able to disagree: one decides which weeks the answer
    // covers, the other decides which week a row falls in.
    for (const iso of ['2026-07-29', '2026-08-03', '2026-08-02', '2026-01-01', '2024-02-29']) {
      expect(bucket(`${iso} 06:00:00.000`)).toBe(weekRange(new Date(`${iso}T06:00:00.000Z`)).start)
    }
  })

  it('qualifies the column when given a qualified reference', () => {
    expect(weekStartExpr('t.date')).toContain('t.date')
    expect(weekStartExpr()).toContain(`strftime('%w', date)`)
  })
})

describe('whole-week offsets off the supplied Monday, against real SQLite', () => {
  // The prompt's new rule claims a fixed day-count shift off an already-correct
  // Monday is exact, unlike the weekday modifier. Checked rather than assumed.
  const db = new Database(':memory:')
  const shift = (anchor: string, mod: string): string =>
    (db.prepare(`SELECT date(?, ?) AS d`).get(anchor, mod) as { d: string }).d

  it('lands on a Monday for every multiple of 7, in both directions', () => {
    for (let n = -60; n <= 60; n++) {
      const mod = `${n < 0 ? '' : '+'}${n * 7} days`
      const got = shift('2026-07-27', mod)
      expect(got, mod).toBe(weekRange(new Date('2026-07-27T00:00:00.000Z'), -n).start)
    }
  })

  it('carries across year and leap-day boundaries', () => {
    expect(shift('2026-01-05', '-14 days')).toBe('2025-12-22')
    expect(shift('2024-03-04', '-14 days')).toBe('2024-02-19')
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

    // The gap flagged when the week rule shipped (2026-08-09) and closed here:
    // the quarter section gave the model a way to reach a quarter that was not
    // explicitly computed ("the three months before <literal>"), and the week
    // section gave it nothing beyond this week and last week.
    describe('weeks other than the two supplied', () => {
      it('teaches whole-day shifts off the supplied Monday', () => {
        expect(prompt).toContain(`date >= date('2026-07-27','-14 days') AND date < date('2026-07-27','-7 days')`)
        expect(prompt).toMatch(/Multiples of 7 days only, always off that literal, never off date\('now'\)/)
      })

      it('carries a worked example for a week that was not supplied', () => {
        const twoWeeks = answerLines.filter((l) => /'-14 days'/.test(l))
        expect(twoWeeks).toHaveLength(1)
        expect(twoWeeks[0]).toContain('SUM(-amount) / 100.0 AS total_spent')
        // Anchored to the literal, not to now.
        expect(twoWeeks[0]).not.toMatch(/date\('now'/)
      })

      it('teaches weekly bucketing with the verified expression, verbatim', () => {
        expect(prompt).toContain(weekStartExpr())
        expect(prompt).toMatch(/copying it character for character/)
      })

      it('names the weekday-modifier bucket trap so it is not reinvented', () => {
        expect(prompt).toContain(`date(date,'weekday 1','-7 days')`)
        expect(prompt).toMatch(/every Monday row is filed under the previous week/)
      })

      it('carries a worked bucketing example that still bounds its own window', () => {
        const bucketed = answerLines.filter((l) => l.includes('AS week_start'))
        expect(bucketed).toHaveLength(1)
        expect(bucketed[0]).toContain('GROUP BY week_start')
        // The bucket key decides which week a row is in, not which weeks are in
        // scope — so an explicit half-open range is still required.
        expect(bucketed[0]).toContain(`date >= date('2026-07-27','-21 days') AND date < '2026-08-03'`)
      })

      it('never demonstrates the weekday modifier on an answer line', () => {
        // Few-shot shape beats prose, so the trap may appear only in the
        // prohibition, never in SQL the model is being shown to copy.
        expect(answerLines.filter((l) => /weekday \d/.test(l))).toEqual([])
      })
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
