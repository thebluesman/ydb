# Transaction accuracy — remaining follow-ups

Context for this list: [FOLLOWUPS context — the full review and first pass of
fixes landed in the commit that introduces this file]. These are the items
from that review that were deliberately left for a second pass.

## 1. Net out unlinked reimbursements

The link-based reimbursement netting ships in this pass, but ~AED 11,870 of
"Insurance Reimbursement / Refund" credits aren't linked to their originating
expenses, so they still inflate Total Income until the user links them.

Options:
- Bulk-link UI: "match all credits with `category=Reimbursement` to the
  nearest preceding expense with `reimbursableFor` set" (nearest-by-date,
  nearest-by-amount, or explicit pick).
- Auto-exclude any credit with `category=Reimbursement` even when unlinked —
  silently changes Total Income so add a tooltip explaining the exclusion.

Rejected for this pass: silently changing totals without user intent.

## 2. Float → integer cents

`prisma/schema.prisma` still stores `amount`, `openingBalance`, `creditLimit`,
`monthlyLimit` as `Float`. Already flagged by the top-of-file TODO. Summing
thousands of float values produces reconciliation drift — the split validator
already hardcodes a 0.01 tolerance (`app/api/transactions/[id]/split/route.ts`).

Required work:
- Schema change to `Int` (cents).
- Data migration: multiply all existing rows by 100 and round.
- Conversion at every read/write boundary (display, form inputs, chat SQL,
  importer, vendor rule min/maxAmount, budget limits).
- Remove the 0.01 tolerance in split validation.

## 3. Edit a linked transfer's counterpart account

`PATCH /api/transactions/[id]` now mirrors `date` / `amount` / `description` /
`status` / `notes` to the linked counterpart, but does NOT re-pair when the
user changes `accountId` or `transferCounterpartAccountId`. If the user
re-targets a transfer, the original counterpart is orphaned on its old
account.

Fix: on `accountId`/`transferCounterpartAccountId` change, delete the old
counterpart and create a fresh one on the new account, re-linking via
`linkedTransferId`. Needs a `$transaction` and a clear UI affordance
("Move transfer to another account").

## 4. Soften DELETE cascade on linked transfers

`DELETE /api/transactions/[id]` now deletes the linked transfer counterpart
too. For pairs created via `POST /manual` that's correct. For pairs the user
manually linked via the ledger's transfer-link modal (after importing both
statements), deleting one side probably shouldn't wipe the counterpart row
the user imported.

Fix options:
- Track the pair's origin (`createdVia: 'import' | 'manual'`) and only cascade
  on `'manual'`.
- UI confirm: "This transfer has a linked counterpart on [Account]. Delete
  both, unlink and delete just this one, or cancel?"

## 5. Existing-data anomalies

A few rows in the current DB have signs that don't match the convention and
won't self-correct under the fixed code:

- ENBD row 226: `+AED 2,447.73 Credit Card Payment` pointing at DIB-Prime.
  Positive on a current account means cash inflow — but it's described as a
  card payment. Either a card refund miscategorised, or a data entry error.
- EI-RTA row 250: `+AED 2,161.59 Credit Card Payment`, no counterpart row on
  ENBD for the same date. Likely the ENBD-side counterpart was recorded
  separately (row 189) with a different date.
- Several ENBD transfers to/from LivX with no matching row on the other side
  (189, 209, 222, 235…), creating gaps in LivX's pre-opening state.

Fix: one-off data cleanup pass — read each anomaly, reconcile against the
original statement, either correct the sign/description or link the row to
the correct counterpart. Not a code change.

## 6. Importer creates one-sided transfers

`POST /api/transactions` (bulk import) keeps one-row-per-transfer because the
user typically imports each account's statement separately, and each
statement represents one side of the transfer. If the user imports both
statements, both sides end up in the DB naturally.

Trade-off: if the user only ever imports one of the two accounts involved in
a transfer, the counterpart account's balance is silently wrong. A "force
two-sided" option at import time (`?autopair=1`) would let power-users
opt in.

## 7. Model-level integrity constraints

Write-side validation in `lib/transactionValidation.ts` catches most bad
writes, but the DB has no constraints. Would be nice to:

- Add a `CHECK` on `Transaction.amount` sign vs `transactionType` (sqlite
  supports CHECK).
- Foreign-key `transferCounterpartAccountId → Account.id`. (Already present.)
- Enforce `linkedTransferId` is symmetric (A.linkedTransferId = B.id ⇔
  B.linkedTransferId = A.id) — needs a trigger, sqlite-specific.
- `onDelete: Cascade` for split legs instead of the current application-level
  cascade in `[id]/route.ts DELETE`.

These hardening moves are nice-to-have; the app-level guard is sufficient.

## 8. Category handling on splits

When a parent has legs, the dashboard counts the legs (granular categories)
and the ledger stats count the parent (single category). Totals match; the
per-category split differs. Not a correctness issue, but the ledger's
category filter won't surface a split leg's category unless the leg is
shown. Consider: show legs inline in the ledger filter results when a
category filter is active, even if the parent doesn't match.
