# ADR-0004: YNAB edits and deletions are detected and reported, never applied

Status: Accepted — detection mechanism superseded by [ADR-0005](0005-ynab-change-detection-immutable-snapshot.md)
Date: 2026-07-26

## Context

ADR-0001 scoped the integration as a one-way YNAB→YDB pull. It said nothing about *mutations*: a
delta pull (`fetchYnabTransactions`, `lib/ynab.ts`) returns not only new transactions but also ones
edited in YNAB since the last cursor (same `ynabId`, different content) and tombstones for ones
deleted there.

Today `filterAlreadyImported` (`lib/ynabImport.ts`) drops any row whose `ynabId` already exists and
folds it into `skippedAlreadyImported`, which the confirm modal reports as "N already imported
(skipped)". Deleted rows are counted in `skippedDeleted` and otherwise ignored. Both read as
reassurance for what is actually divergence between YNAB and YDB.

This matters beyond tidiness: ADR-0002's Phase 1→2 gate is "several weeks with no mis-mapped
transactions." Drift that never surfaces makes that gate unfalsifiable — the absence of reported
problems would stop being evidence of anything.

## Decision

In Phase 1, YDB **detects** YNAB-side edits and deletions and **reports** them as items needing
manual resolution. It does not apply them. Specifically:

- **No update propagation.** An imported YDB row is never overwritten by a later pull. Overwriting
  would let a remote system silently clobber a row Shyam may have corrected locally, and would make
  the importer's writes non-idempotent in a way ADR-0002 deliberately avoided.
- **No delete propagation.** Nothing in the import path deletes YDB ledger rows. Destructive writes
  driven by a remote cursor are a materially larger decision than reads, and the reset in ADR-0003 is
  the only sanctioned bulk-delete path.
- **Detection is by content fingerprint, not by delivery.** A re-delivered `ynabId` counts as changed
  only if the fields YDB maps from YNAB (date, amount in cents, account, category, description, and
  transfer counterpart) differ from the stored row. YNAB's delta API does not guarantee it returns
  only true changes, and treating every re-delivery as an edit would produce a counter noisy enough
  to be ignored — destroying the signal the Phase 2 gate depends on. False positives are the failure
  mode to avoid; fields YDB owns locally are excluded from the comparison.
- **Reports name the rows, not just a count.** Both changed and deleted items are listed with enough
  identity to act on (date, payee/description, amount, account). Deletions are reported only where
  the tombstone's `ynabId` actually matches a YDB row; tombstones for never-imported transactions are
  ignored entirely.
- **Unresolved divergence holds the cursor.** As with the skip counters in the import route, the
  delta cursor does not advance while changed or deleted items are outstanding. This makes the report
  persistent instead of a one-shot notice that is permanently lost if missed, and it self-clears once
  Shyam reconciles the row by hand.
- Applying edits or deletions automatically is Phase 2 territory and requires an ADR superseding this
  one. That ADR must say what wins when YDB and YNAB have both changed a row.

## Consequences

- Buys an honest divergence signal for the Phase 1→2 trust gate, with no destructive or overwriting
  writes in the import path.
- Costs manual reconciliation for every edit or deletion made in YNAB after a row is imported, and a
  full re-pull on each import while divergence is outstanding (slower import; not incorrect).
- Given up: YNAB→YDB convergence. During Phase 1, YDB is a record of what YNAB *said*, reconciled by
  hand — not a mirror of YNAB's current state.
