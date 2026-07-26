# Product spec — YNAB migration project

Owned by `@product-manager`. Scope: moving Shyam off YNAB and onto YDB as the system of record,
without losing reliability during the transition. This is additive to YDB's existing ledger/budget
product (unchanged) — it's the migration path, not a redesign.

## Problem

Shyam pays for YNAB and wants to stop, but YNAB is currently his trusted, up-to-date source of truth
(entered via a separate SMS-parsing pipeline outside this repo). A hard cutover risks losing data
fidelity YDB hasn't proven yet. The migration needs a period where both tools run, with YNAB's data
flowing into YDB, so Shyam can validate YDB against real daily use before cancelling YNAB.

## Users

Shyam only (YDB is single-user, LAN-only — see `docs/architecture.md`).

## Scope

- **In scope:** pulling YNAB transactions into YDB (ADR-0001), starting manual (ADR-0002 Phase 1),
  account/category mapping between the two systems, dedupe/idempotency.
- **Out of scope (this project):** the SMS→Signal→YNAB capture pipeline (lives outside this repo,
  already decided separately), any write-back to YNAB, any other cloud/bank integration.

## Success criteria

- Phase 1: Shyam can, from Settings, pull all YNAB transactions since the last import into YDB with
  correct accounts/categories/amounts, without duplicates, in a few clicks.
- Phase 2 (later, gated — ADR-0002): the same pull runs automatically with no manual trigger, once
  Phase 1 has proven trustworthy.
- Ultimate exit criterion (not this project's deliverable, but the reason it exists): Shyam cancels
  YNAB because YDB fully covers his day-to-day budgeting workflow.

## Non-goals

Carried from `IMPROVEMENT_PLAN.md` §4 except where ADR-0001 explicitly amends them: no auth/
multi-user, no bank-credential-linking integrations (Plaid etc.), no SQLite/Prisma migration, no
visual redesign, no weakening of the money-in-cents or read-only-SQL invariants.
