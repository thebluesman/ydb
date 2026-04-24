# Transaction accuracy — remaining follow-ups

Items deliberately left for a future pass after the Float→Int / validation /
LLM-hardening work landed.

## 1. Net out unlinked reimbursements

Link-based reimbursement netting is in place, but ~AED 11,870 of "Insurance
Reimbursement / Refund" credits aren't linked to their originating expenses,
so they still inflate Total Income until the user links them.

Options:
- Bulk-link UI: "match all credits with `category=Reimbursement` to the
  nearest preceding expense with `reimbursableFor` set" (nearest-by-date,
  nearest-by-amount, or explicit pick).
- Auto-exclude any credit with `category=Reimbursement` even when unlinked —
  silently changes Total Income so add a tooltip explaining the exclusion.

Rejected in prior passes: silently changing totals without user intent.

## 2. Soften DELETE cascade on linked transfers

`DELETE /api/transactions/[id]` deletes the linked counterpart alongside the
row. For pairs the user linked manually (ledger's transfer-link modal after
importing both statements), the counterpart was a real imported row — losing
it on delete is probably not what they want.

Fix options:
- Track `createdVia: 'import' | 'manual'` on Transaction; only cascade on
  `'manual'` (in-app transfer creation).
- UI confirm: "This transfer has a linked counterpart on [Account]. Delete
  both, unlink and delete just this one, or cancel?"

## 3. Existing-data anomalies

A few rows in the previous DB had signs that didn't match the convention —
e.g. ENBD row 226, EI-RTA row 250, several ENBD→LivX transfers with no
matching side. After the fresh-start DB those rows no longer exist, but the
same pattern can reappear if the user imports one side of a paired transfer
without the other. Fix is a one-off reconcile pass when new anomalies show
up, not code.

## 4. Importer creates one-sided transfers

`POST /api/transactions` (bulk import) keeps one-row-per-transfer because each
statement represents one side. If the user imports both statements, both sides
end up in the DB naturally. A "force two-sided" option at import time
(`?autopair=1`) would let power-users opt in.

## 5. DB-level integrity constraints

Application-level validation covers the common cases. Additional
nice-to-haves:

- CHECK on `Transaction.amount` sign vs `transactionType` (sqlite supports
  CHECK).
- Enforce `linkedTransferId` symmetry via a trigger.
- `onDelete: Cascade` for split legs instead of application-level cascade.

## 6. Category handling on splits

When a parent has legs, the dashboard counts the legs (granular categories)
and the ledger stats count the parent (single category). Totals match; the
per-category split differs. Not a correctness issue, but the ledger's
category filter won't surface a split leg's category unless the leg is
shown. Consider: show legs inline in the ledger filter results when a
category filter is active, even if the parent doesn't match.
