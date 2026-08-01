import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ADR-0021: transfer-pair exclusivity is enforced by two SQLite triggers.
 *
 * `tests/transactionDeleteCascade.test.ts` next door is an in-memory `Map`
 * simulation of Prisma, which by construction cannot exercise a DB trigger.
 * This suite runs the shipped migration SQL — read off disk, not copied — into
 * a real SQLite instance carrying the real `ON DELETE SET NULL` self-FK, then
 * replays the statement sequences the five app write paths actually issue.
 *
 * The interesting property is not that violations abort. It is that the six
 * legitimate sequences do NOT, because each of them passes through a transient
 * one-sided state that a naive symmetry check would reject.
 */

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '20260802103000_transfer_pair_exclusivity_triggers',
    'migration.sql',
  ),
  'utf-8',
)

/**
 * The slice of `"Transaction"` these triggers touch, with the self-referencing
 * FK declared exactly as the baseline migration declares it — `ON DELETE SET
 * NULL` is load-bearing for sequences 5 and 6.
 */
const SCHEMA = `
CREATE TABLE "Transaction" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "amount" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT NOT NULL DEFAULT '',
  "accountId" INTEGER NOT NULL DEFAULT 1,
  "createdVia" TEXT NOT NULL DEFAULT 'manual',
  "linkedTransferId" INTEGER,
  CONSTRAINT "Transaction_linkedTransferId_fkey" FOREIGN KEY ("linkedTransferId")
    REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Transaction_linkedTransferId_idx" ON "Transaction"("linkedTransferId");
`

let db: InstanceType<typeof Database>

/** Inserts an unlinked row and returns its assigned id. */
function insertRow(accountId = 1, amount = -1000): number {
  const info = db
    .prepare(`INSERT INTO "Transaction" ("amount", "accountId") VALUES (?, ?)`)
    .run(amount, accountId)
  return Number(info.lastInsertRowid)
}

function insertLinked(accountId: number, amount: number, linkedTransferId: number): number {
  const info = db
    .prepare(
      `INSERT INTO "Transaction" ("amount", "accountId", "linkedTransferId") VALUES (?, ?, ?)`,
    )
    .run(amount, accountId, linkedTransferId)
  return Number(info.lastInsertRowid)
}

function link(id: number, target: number | null): void {
  db.prepare(`UPDATE "Transaction" SET "linkedTransferId" = ? WHERE "id" = ?`).run(target, id)
}

function linkOf(id: number): number | null {
  const row = db.prepare(`SELECT "linkedTransferId" AS l FROM "Transaction" WHERE "id" = ?`).get(id) as
    | { l: number | null }
    | undefined
  return row ? row.l : null
}

function rowCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM "Transaction"`).get() as { c: number }).c
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  db.exec(MIGRATION_SQL)
})

afterEach(() => db.close())

describe('the migration installs both triggers', () => {
  it('creates exactly the two ADR-0021 triggers on "Transaction"', () => {
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      .all() as { name: string }[]
    expect(names.map((n) => n.name)).toEqual([
      'Transaction_transfer_pair_insert',
      'Transaction_transfer_pair_update',
    ])
  })
})

describe('legitimate write sequences still succeed', () => {
  // Path 1a/1b: app/api/transactions/manual/route.ts (two-sided create) and
  // app/api/ynab/import/route.ts (transfer loop) issue the identical three
  // statements. Side 2 is inserted already pointing back; side 1 is repointed
  // afterwards, so the pair is one-sided for one statement.
  it('two-sided create — manual/route.ts shape', () => {
    const side1 = insertRow(1, -5000)
    const side2 = insertLinked(2, 5000, side1)
    link(side1, side2)
    expect(linkOf(side1)).toBe(side2)
    expect(linkOf(side2)).toBe(side1)
  })

  it('two-sided create — ynab/import/route.ts transfer loop, repeated across pairs', () => {
    // Two pairs in a row, because the import writes many in one transaction and
    // the second pair must not see the first as an inbound claimant.
    for (let i = 0; i < 2; i++) {
      const created1 = insertRow(1, -2500)
      const created2 = insertLinked(2, 2500, created1)
      link(created1, created2)
      expect(linkOf(created1)).toBe(created2)
      expect(linkOf(created2)).toBe(created1)
    }
    expect(rowCount()).toBe(4)
  })

  // Path 2: app/api/transactions/[id]/link/route.ts POST.
  it('link POST on two unlinked rows', () => {
    const a = insertRow(1, -3000)
    const b = insertRow(2, 3000)
    link(a, b)
    link(b, a)
    expect(linkOf(a)).toBe(b)
    expect(linkOf(b)).toBe(a)
  })

  // Path 3: the same POST re-run. Both 409 pre-checks pass through when the
  // existing pointer already names the other side, so the updates re-execute.
  it('link POST re-run on an already-symmetric pair is idempotent', () => {
    const a = insertRow(1, -3000)
    const b = insertRow(2, 3000)
    link(a, b)
    link(b, a)
    expect(() => {
      link(a, b)
      link(b, a)
    }).not.toThrow()
    expect(linkOf(a)).toBe(b)
    expect(linkOf(b)).toBe(a)
  })

  // Path 4: link/route.ts DELETE. Both writes are NULL, so the guard skips.
  it('link DELETE unpairs both sides', () => {
    const a = insertRow(1, -3000)
    const b = insertRow(2, 3000)
    link(a, b)
    link(b, a)
    link(a, null)
    link(b, null)
    expect(linkOf(a)).toBeNull()
    expect(linkOf(b)).toBeNull()
  })

  // Path 5: the needsRepair branch of app/api/transactions/[id]/route.ts PATCH.
  // The old counterpart is unlinked, deleted (FK nulls A as a side effect), A
  // is explicitly nulled, a fresh counterpart is inserted pointing at A, and A
  // is repointed at it.
  it('PATCH re-pair branch — old counterpart deleted, new one created', () => {
    const a = insertRow(1, -4000)
    const old = insertRow(2, 4000)
    link(a, old)
    link(old, a)

    link(old, null)
    db.prepare(`DELETE FROM "Transaction" WHERE "id" = ?`).run(old)
    link(a, null)
    const fresh = insertLinked(3, 4000, a)
    link(a, fresh)

    expect(linkOf(a)).toBe(fresh)
    expect(linkOf(fresh)).toBe(a)
    expect(rowCount()).toBe(2)
  })

  // Path 6: the DELETE cascade in [id]/route.ts with an imported counterpart —
  // the counterpart survives holding NULL, which is exactly the state a naive
  // symmetry constraint would reject.
  it('DELETE cascade leaves an imported counterpart surviving with NULL', () => {
    const a = insertRow(1, -6000)
    const counterpart = insertRow(2, 6000)
    link(a, counterpart)
    link(counterpart, a)

    link(counterpart, null)
    db.prepare(`DELETE FROM "Transaction" WHERE "id" = ?`).run(a)

    expect(rowCount()).toBe(1)
    expect(linkOf(counterpart)).toBeNull()
  })
})

describe('violations are rejected', () => {
  /** A clean pair plus a spare row, to assert nothing is collateral damage. */
  function fixture() {
    const a = insertRow(1, -1000)
    const b = insertRow(2, 1000)
    link(a, b)
    link(b, a)
    const spare = insertRow(3, 1000)
    return { a, b, spare }
  }

  function expectPairIntact(a: number, b: number) {
    expect(linkOf(a)).toBe(b)
    expect(linkOf(b)).toBe(a)
  }

  it('class 1 — self-link on UPDATE', () => {
    const { spare, a, b } = fixture()
    expect(() => link(spare, spare)).toThrow(/cannot be linked to itself/)
    expect(linkOf(spare)).toBeNull()
    expectPairIntact(a, b)
  })

  it('class 1 — self-link on INSERT', () => {
    // Predict the id the row is about to get, then point it at itself. This is
    // the case that reads as -1 (and so passes) under a BEFORE INSERT trigger.
    const { a, b } = fixture()
    const nextId = rowCount() + 1
    expect(() => insertLinked(4, 1000, nextId)).toThrow(/cannot be linked to itself/)
    expect(rowCount()).toBe(3)
    expectPairIntact(a, b)
  })

  it('class 2 — pointing at a row that is already half of another pair', () => {
    const { a, b, spare } = fixture()
    expect(() => link(spare, b)).toThrow(/counterpart is already linked to a different transaction/)
    expect(linkOf(spare)).toBeNull()
    expectPairIntact(a, b)
  })

  it('class 3 — A→B then repointing B→C, abandoning A', () => {
    // The case a one-sided "does my counterpart point back" predicate misses:
    // at the moment B→C is written, C is still NULL and looks innocent.
    const a = insertRow(1, -1000)
    const b = insertRow(2, 1000)
    const c = insertRow(3, 1000)
    link(a, b)
    expect(() => link(b, c)).toThrow(/another transaction still points at this one/)
    expect(linkOf(a)).toBe(b)
    expect(linkOf(b)).toBeNull()
    expect(linkOf(c)).toBeNull()
  })

  it('class 4 — INSERT of a new row stealing an already-paired counterpart', () => {
    const { a, b } = fixture()
    expect(() => insertLinked(4, 1000, b)).toThrow(
      /counterpart is already linked to a different transaction/,
    )
    expect(rowCount()).toBe(3)
    expectPairIntact(a, b)
  })

  it('an aborted write inside a transaction rolls the whole sequence back', () => {
    // The app issues these in a prisma.$transaction, so the abort must not
    // leave the first half of a two-statement pairing behind.
    const { a, b } = fixture()
    const c = insertRow(4, 1000)
    const steal = db.transaction(() => {
      link(c, b)
      link(b, c)
    })
    expect(() => steal()).toThrow(/counterpart is already linked to a different transaction/)
    expect(linkOf(c)).toBeNull()
    expectPairIntact(a, b)
  })
})
