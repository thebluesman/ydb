import { describe, expect, it } from 'vitest'
import { executeReadonlyQuery, ReadonlyQueryError, READONLY_ROW_CAP } from '@/lib/prisma'

describe('executeReadonlyQuery guard', () => {
  it('rejects forbidden tables by name', () => {
    expect(() => executeReadonlyQuery('SELECT * FROM Setting')).toThrow(ReadonlyQueryError)
    expect(() => executeReadonlyQuery('SELECT * FROM ChatMessage')).toThrow(ReadonlyQueryError)
    expect(() => executeReadonlyQuery('SELECT * FROM VendorRule')).toThrow(ReadonlyQueryError)
    expect(() => executeReadonlyQuery('SELECT * FROM Budget')).toThrow(ReadonlyQueryError)
  })

  it('rejects quoted forbidden identifiers', () => {
    expect(() => executeReadonlyQuery('SELECT * FROM "Setting"')).toThrow(ReadonlyQueryError)
  })

  it('rejects sqlite_master and friends', () => {
    expect(() => executeReadonlyQuery('SELECT * FROM sqlite_master')).toThrow(ReadonlyQueryError)
    expect(() => executeReadonlyQuery('SELECT * FROM sqlite_schema')).toThrow(ReadonlyQueryError)
  })

  it('does NOT match forbidden name inside a string literal', () => {
    // "setting" appears only inside a string — should not trip the guard.
    // The query itself will run against "Transaction" which exists but is
    // empty on a fresh db; that should produce [].
    expect(
      executeReadonlyQuery(
        `SELECT * FROM "Transaction" WHERE description = 'wedding setting' LIMIT 1`,
      ).rows,
    ).toEqual([])
  })

  it('allows SELECT queries', () => {
    expect(executeReadonlyQuery('SELECT 1 AS one').rows).toEqual([{ one: 1 }])
  })

  it('allows WITH (CTE) queries', () => {
    const { rows } = executeReadonlyQuery(`WITH t AS (SELECT 1 AS n) SELECT n FROM t`)
    expect(rows).toEqual([{ n: 1 }])
  })

  it('rejects non-read statements', () => {
    expect(() => executeReadonlyQuery('INSERT INTO "Transaction" (id) VALUES (1)')).toThrow(
      ReadonlyQueryError,
    )
    expect(() => executeReadonlyQuery('UPDATE Category SET name = \'x\'')).toThrow(
      ReadonlyQueryError,
    )
    expect(() => executeReadonlyQuery('DROP TABLE Account')).toThrow(ReadonlyQueryError)
  })

  it('caps result rows at READONLY_ROW_CAP and flags truncation', () => {
    // Generate more rows than the cap using a recursive CTE, no table needed.
    const n = READONLY_ROW_CAP + 50
    const sql = `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ${n}) SELECT x FROM seq`
    const { rows, truncated } = executeReadonlyQuery(sql)
    expect(rows).toHaveLength(READONLY_ROW_CAP)
    expect(truncated).toBe(true)
  })

  it('does not flag truncation when the result fits under the cap', () => {
    const sql = `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < 10) SELECT x FROM seq`
    const { rows, truncated } = executeReadonlyQuery(sql)
    expect(rows).toHaveLength(10)
    expect(truncated).toBe(false)
  })

  it('allows words that CONTAIN a forbidden identifier but are distinct', () => {
    // Make-believe table name. The guard should only trip on exact token match,
    // so a column or alias containing "setting" as a substring must not trip.
    // We use SELECT with an alias to avoid needing a real table.
    expect(
      executeReadonlyQuery(`SELECT 1 AS my_settings_count`).rows,
    ).toEqual([{ my_settings_count: 1 }])
  })
})
