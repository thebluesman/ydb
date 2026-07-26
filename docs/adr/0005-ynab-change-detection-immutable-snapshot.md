# ADR-0005: YNAB change detection compares against an immutable snapshot, not the live row

Status: Accepted
Date: 2026-07-26
Supersedes: the detection-mechanism bullet of [ADR-0004](0004-ynab-mutations-detect-and-report.md)

## Context

ADR-0004 decided that YNAB-side edits are detected and reported, never applied, and that detection is
by content fingerprint over "the fields YDB maps from YNAB … fields YDB owns locally are excluded
from the comparison." That principle assumed each mapped field is owned by exactly one side. It is
not: `date`, `amount`, `accountId`, `category`, `description` **and** `originalDescription` are all
editable after import via `PATCH /api/transactions/[id]`, which does not clear `ynabId`.

The consequence, confirmed by `@qa` against an unchanged YNAB response: recategorising an imported
transaction in the ledger — the most common thing Shyam will do, and much of the point of migrating
off YNAB — makes every subsequent import report that row as `changedInYnab`. Per ADR-0004 the cursor
holds while changed items are outstanding, so one local edit permanently degrades every future import
to a full-history re-scan and plants a report entry that cannot be resolved except by reverting
Shyam's own edit. That is precisely the false-positive failure mode ADR-0004 named as the one to
avoid, and it makes the ADR-0002 Phase 1→2 gate ("no mis-mapped transactions") unfalsifiable in the
opposite direction: the report is noise, so it stops being read.

Narrowing the fingerprint to supposedly-immutable columns does not fix this — `originalDescription`
is also PATCH-editable, and every narrowing trades a real false positive for a real blind spot
(a YNAB-side recategorisation would go undetected, which is exactly the class of drift the gate
exists to catch).

## Decision

Change detection compares the newly-pulled YNAB row against **a frozen snapshot of what YNAB said at
import time**, stored on the YDB row and never written by any path other than the importer's initial
create. It is not compared against the row's current, possibly user-edited, values.

- The snapshot is a single string column `ynabFingerprint`, `String?`, nullable, on `Transaction`.
  Nullable because non-YNAB rows (CSV, PDF, manual) have no snapshot; not indexed — it is only ever
  read via `ynabId` lookup.
- It is written exactly once, in the same `create` that writes `ynabId`. No other write path
  (`PATCH`, transfer linking, split, reimbursement, reconcile) may set, clear, or update it. Local
  edits are therefore invisible to detection, by construction, for every field — present and future.
- Its content is a canonical, versioned serialisation of **YNAB-native** values, not YDB-mapped ones:
  version tag, YNAB `date`, YNAB `amount` in milliunits, YNAB `account_id`, YNAB `category_id`,
  YNAB `payee_name`, YNAB `transfer_account_id`. YNAB-native so that the snapshot stays meaningful
  across YDB-side id churn (e.g. the ADR-0003 reset recreating accounts) and so that a YDB mapping
  change is never mistaken for a YNAB edit.
- A row is reported as changed iff its stored `ynabFingerprint` and the fingerprint recomputed from
  the freshly-pulled YNAB row differ **and both carry the same version tag**. A row with a null
  snapshot, or one whose version tag differs from the current code's, is treated as unchanged and
  counted as a duplicate. Changing the fingerprint's field set is therefore a version-tag bump that
  degrades gracefully to "no detection" instead of flagging the entire ledger at once.

Everything else in ADR-0004 stands unchanged: no update propagation, no delete propagation, reports
name the rows, unresolved divergence holds the cursor, and applying edits automatically remains
Phase 2 territory requiring its own ADR.

## Consequences

- Detection becomes correct under real day-to-day ledger editing: any YNAB-side edit is caught
  regardless of what Shyam has changed locally, and no local edit can ever produce a report entry.
  The `changedInYnab` counter becomes trustworthy enough for the ADR-0002 gate to mean something.
- Costs a schema migration and one extra column written per imported row.
- Given up: the ability to detect that a *local* edit has diverged from YNAB. YDB no longer knows,
  after the fact, whether a difference between the row and YNAB is Shyam's doing or YNAB's — it only
  knows whether YNAB's own report of that transaction changed. That is the right trade for Phase 1
  (ADR-0004: YDB is a record of what YNAB said, reconciled by hand), but a Phase 2 ADR that applies
  edits automatically must decide what wins when both sides changed, and will need the snapshot plus
  the live row to answer it — which this column makes possible.
