# ADR-0021: Transfer-pair integrity is enforced by a DB trigger, on exclusivity rather than symmetry

Status: Accepted
Date: 2026-08-02

## Context

`Transaction.linkedTransferId` is a self-referencing FK that is meant to be held mutual:
`A.linkedTransferId = B.id` and `B.linkedTransferId = A.id`. Nothing in the database enforces that.
It is maintained by hand across five write paths in four files — the PATCH re-pair branch and the
DELETE cascade in `app/api/transactions/[id]/route.ts`, POST and DELETE in
`app/api/transactions/[id]/link/route.ts`, the two-sided create in
`app/api/transactions/manual/route.ts`, and the transfer loop in `app/api/ynab/import/route.ts`.
(FOLLOWUPS.md §5 counts four paths in three files; it misses `manual/route.ts`.) Each is a place
asymmetry can be reintroduced by a future edit. It is the last open item in FOLLOWUPS.md §5; the
other two DB-hardening items shipped in
`prisma/migrations/20260716201150_split_leg_cascade_and_check_constraint`.

The FK is `ON DELETE SET NULL` by design, so a deleted counterpart legitimately leaves a survivor
holding NULL. Every one of the five paths also passes through a transient one-sided state *inside*
its transaction — each nulls a back-pointer before repointing it. SQLite triggers are immediate and
per-row, not deferred, so any enforced predicate has to treat one-sided NULL as legal or it will
abort the app's own correct writes.

Reading the paths shows the invariant is not literally "symmetry". Two rows pointing at each other
is the *goal state*, but the property that must hold after every individual statement is weaker and
differently shaped: a non-NULL pointer may not target a row that is already spoken for, and may not
orphan a row that still points back. A naive symmetry check both over-fires (on the legal one-sided
NULL) and under-fires: checking only "does my counterpart point back at me" misses `A→B` then
`B→C`, which leaves `A→B` dangling and is never caught, because at the moment `B→C` is written, `C`
is still NULL and looks innocent.

## Decision

Enforce transfer-pair integrity in the database with two hand-written SQLite triggers on
`"Transaction"` — `AFTER INSERT` and `AFTER UPDATE OF "linkedTransferId"` — each guarded by
`WHEN NEW."linkedTransferId" IS NOT NULL` and aborting via `RAISE(ABORT, ...)` on three conditions:

1. **Self-link** — `NEW.linkedTransferId = NEW.id`.
2. **Counterpart already taken** — the target row's `linkedTransferId` is non-NULL and is not
   `NEW.id`.
3. **Abandoning an inbound pointer** — some row other than the target still points at `NEW.id`.

Writes of `NULL` are never checked, which is what makes the `ON DELETE SET NULL` survivor and every
transient mid-transaction state legal.

`AFTER`, not `BEFORE`, is load-bearing for the INSERT trigger: in a `BEFORE INSERT` trigger SQLite
has not yet assigned the autoincrement rowid, and `NEW.id` reads as `-1`, which silently breaks
conditions 1 and 2. Verified directly.

Both triggers go in one hand-edited migration, following the comment-header convention of the
20260716201150 migration, with the negated-SELECT violation counts recorded in it.

## Consequences

Symmetry stops depending on five hand-written call sites agreeing with each other, and a sixth write
path added later inherits the guarantee instead of having to re-derive it. Condition 3 in particular
closes a hole that no amount of care at the application layer currently covers — the app's own 409
checks in the link route only inspect outbound pointers, never inbound ones.

The cost is that an operation the app currently permits will now fail: linking a row that a third
transaction still points at returns a 500 from a raw SQLite error rather than a clean 409. That
inbound case cannot arise from today's data (verified zero), but the link route should be given a
matching inbound pre-check so the failure surfaces as a 409 with a real message. Until it is, the
trigger is a backstop that fails ugly rather than a validation layer.

This also puts durable, non-Prisma-expressible logic on `"Transaction"` for the second time. A
future `RedefineTables` migration on that table drops both these triggers *and* the existing sign
CHECK, silently, because Prisma rebuilds the table from its own schema. Any future migration that
rebuilds `"Transaction"` must re-create all three. That is now recorded in `docs/architecture.md`.

Testing needs a real SQLite instance, not the in-memory `Map` simulation in
`tests/transactionDeleteCascade.test.ts`; the `better-sqlite3` harness in
`tests/chatSqlRegressionFixtures.test.ts` is the pattern to copy.
