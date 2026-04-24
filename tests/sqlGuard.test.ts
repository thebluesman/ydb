import { describe, expect, it } from 'vitest'
import { executeReadonlyQuery, ReadonlyQueryError } from '@/lib/prisma'

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
      ),
    ).toEqual([])
  })

  it('allows SELECT queries', () => {
    expect(executeReadonlyQuery('SELECT 1 AS one')).toEqual([{ one: 1 }])
  })

  it('allows WITH (CTE) queries', () => {
    const rows = executeReadonlyQuery(`WITH t AS (SELECT 1 AS n) SELECT n FROM t`)
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

  it('allows words that CONTAIN a forbidden identifier but are distinct', () => {
    // Make-believe table name. The guard should only trip on exact token match,
    // so a column or alias containing "setting" as a substring must not trip.
    // We use SELECT with an alias to avoid needing a real table.
    expect(
      executeReadonlyQuery(`SELECT 1 AS my_settings_count`),
    ).toEqual([{ my_settings_count: 1 }])
  })
})
