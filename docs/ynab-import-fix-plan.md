# YNAB Import (Phase 1) — Fix Plan

Source: `/code-review` and `@qa` passes on branch `ynab-import-pipeline` (commit `ee14838`),
2026-07-26. Findings ordered by priority — blockers first.

## Blocking (must fix before merge)

### 1. Delta cursor advances past deliberately-skipped rows (data loss)
- **File:** `app/api/ynab/import/route.ts:194`
- **Problem:** `plan.serverKnowledge` is upserted unconditionally on commit, even when rows were
  skipped for unmapped accounts (`lib/ynabImport.ts:273`), incomplete transfer pairs (`:302`),
  cross-currency transfers (`:321`), or unmapped transfer counterparts (`:311`). Since
  `fetchYnabTransactions` only returns changed-since-cursor rows, skipped transactions become
  permanently unreachable — recovery requires manually deleting the `ynabServerKnowledge` Setting
  row.
- **Fix:** Don't advance the cursor when any skip counter is nonzero
  (`skippedUnmappedAccounts.length > 0 || skippedTransfersIncomplete > 0 ||
  skippedTransfersCrossCurrency > 0`). A re-pull next time is harmless given the existing
  dedupe layers.
- **Why it matters:** Directly threatens the ADR-0002 Phase 1→2 gate ("no mis-mapped
  transactions" over several weeks).

### 2. Edited-in-YNAB transactions are silently dropped on delta pulls
- **Files:** `lib/ynabImport.ts:108` (`filterAlreadyImported`), `lib/ynab.ts:209`
  (`skippedDeleted`), `app/settings/_components/YnabImportManager.tsx:360` (reporting)
- **Problem:** A delta pull returns a transaction because YNAB says it changed — but
  `filterAlreadyImported` treats any existing `ynabId` as a duplicate and drops it. The UI then
  reports it as "N already imported (skipped)," which reads as reassuring instead of flagging
  silent drift. Similarly, `skippedDeleted` counts YNAB tombstones but nothing removes the
  corresponding YDB row.
- **Fix (Phase 1 scope — no full update/delete propagation needed):** Detect the edited-vs-truly-
  duplicate case and report it distinctly, e.g. "N transactions changed in YNAB and were not
  updated in YDB — resolve manually," instead of folding into the generic skip count.
- **Decision needed:** Escalate to `@tech-lead` — this is a design question (how much
  update/delete propagation Phase 1 should attempt), not just a bug fix.

### 3. Same-account transfer mapping hard-fails with a misleading error
- **Files:** `lib/ynabImport.ts:174` (`validateAccountMap`), `app/api/ynab/import/route.ts:76`
- **Problem:** Nothing prevents mapping two YNAB accounts to the same YDB account. A transfer
  between them passes the cross-currency check trivially (account compared to itself), then
  `validateTransactionWrite` rejects it with "transfer counterpart cannot be the same account as
  the source" — which the route wraps as "...would violate the ledger's sign rules," misdiagnosing
  the cause. No recovery path short of changing the mapping outside the guided flow.
- **Fix:** Pre-filter same-account transfers into a skip counter at plan time (same treatment as
  `skippedTransfersCrossCurrency`), and/or reject the mapping itself in `validateAccountMap` when
  two YNAB accounts collapse to one YDB account.

### 4. Missing idempotency test coverage
- **File:** `tests/ynabImport.test.ts`
- **Problem:** `filterAlreadyImported`, `filterAlreadyImportedTransfers`, `planYnabImport`'s
  transfer-pairing/skip logic, and all three route handlers have zero test coverage. Idempotency
  (ADR-0002's core guarantee) is currently asserted only in comments/doc prose.
- **Fix:** Add a run-import-twice integration test using the existing in-memory better-sqlite3
  harness from `tests/transactionsApi.test.ts`. Assert: second run writes 0 rows, transaction
  count unchanged, transfer legs still symmetric (`linkedTransferId` pairs intact).
- **Also add:** unit tests for `planYnabImport`'s transfer pairing — matched pair, orphan leg,
  unmapped counterpart, cross-currency, and the same-account case from finding 3.

## Non-blocking but should fix

### 5. Prisma transaction likely exceeds default 5s timeout on first full import
- **File:** `app/api/ynab/import/route.ts:95`
- **Problem:** ADR-0003 sequences a full ledger reset then a full-history pull — thousands of
  rows, hundreds of transfer pairs (3 queries each), category upserts, import records — all inside
  one `prisma.$transaction` with the default timeout. Rolls back cleanly but gives no signal that
  a retry will fail identically.
- **Fix:** Pass an explicit `{ timeout }` sized for full-history volume; hoist per-row currency
  lookups (see finding 6) out of the validation loop to reduce work inside the transaction.

### 6. Redundant currency lookups per transfer leg
- **File:** `app/api/ynab/import/route.ts:123` (`validateTransactionWrite`)
- **Problem:** Re-fetches each transfer leg's account currency from the DB even though
  `planYnabImport` already built and cached `currencyById` while planning.
- **Fix:** Thread `currencyById` through to validation instead of re-querying.

### 7. Journal/docs mismatch on transfer scope
- **File:** `docs/journal/2026-07.md:39`
- **Problem:** Journal entry says internal YNAB transfers were deferred to Phase 2, but this same
  commit fully implements and tests transfer import (`lib/ynabImport.ts`'s
  `transferLegs`/`PlannedTransfer`/`planYnabImport`, covered in `tests/ynabImport.test.ts`).
  `docs/research/ynab-vs-ydb/findings.md` (same commit) correctly describes transfers as "already
  folded in." `docs/adr/0002` has no such scope-gap language, so the journal citation is
  unverifiable.
- **Fix:** Correct the journal entry to reflect that transfers shipped in Phase 1. Route through
  `@historian` since journal entries are their domain.

## Worth a look, not required

- `lib/ynab.ts:101` — `Math.round` in `milliunitsToCents` is asymmetric at exact halfway points
  (e.g. `-1005` milliunits → `-100` cents, not `-101`). Theoretical given YNAB amounts are always
  multiples of 10 milliunits, but the existing rounding test only covers positive values — tighten
  the test or note the assumption.
- **Split transactions unhandled.** `YnabTransaction` has no `subtransactions` field; split parents
  will import with correct total amount but land in "Uncategorized." Balances stay correct,
  category analysis silently degrades. Verify against a fixture and document as a known Phase 1
  limitation (or fix if cheap).
- `app/api/ynab/import/route.ts:213-215` — stale comment referencing `skipDuplicates`, which the
  code deliberately doesn't use (see `lib/ynabImport.ts:100`).
- Preview and import each issue their own YNAB fetch — the confirmed summary can differ from what
  actually commits if a transaction arrives in between. Small window on a manual action; worth a
  line in the confirm-dialog copy.
- `filterAlreadyImported` builds one `WHERE ynabId IN (...)` over the whole batch — fine on SQLite
  today (32766 param ceiling) but chunk it if the first full-history pull grows large enough to
  approach that limit.

## Suggested order of work

1. Fix 1, 3 (both are small, targeted logic fixes in the same planning/validation path).
2. Add test coverage from fix 4 (write the run-twice test first — it will also exercise 1 and 3).
3. Decide fix 2 with `@tech-lead`, then implement the reporting change.
4. Fix 5 and 6 together (both touch the same transaction/validation hot path).
5. Fix 7 via `@historian`.
6. Sweep the "worth a look" items opportunistically.
