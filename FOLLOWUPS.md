# Transaction accuracy — remaining follow-ups

Items deliberately left for a future pass after the Float→Int / validation /
LLM-hardening work landed.

## 1. Net out unlinked reimbursements — SHIPPED (`13fc673`)

Bulk-match suggestion UI landed: `GET /api/reimbursements/suggest` +
`ReimbursementSuggestModal.tsx`, plus a pending-reimbursement filter chip in
`LedgerView.tsx`. Confirms each pair one at a time through the existing
reimburse endpoint rather than silently excluding credits from Total
Income — consistent with the prior rejection of "silently changing totals
without user intent." The ~AED 11,870 figure described the pre-ADR-0003
database and no longer applies (full ledger reset before the YNAB import).

## 2. Soften DELETE cascade on linked transfers — SHIPPED (`6cb3e7e`)

`Transaction.createdVia: 'import' | 'manual'` now gates the cascade —
`DELETE /api/transactions/[id]` only deletes the linked counterpart when it
was app-created (`createdVia === 'manual'`), never an imported row. See
`app/api/transactions/[id]/route.ts:207`. Covered by
`tests/transactionDeleteCascade.test.ts`.

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

## 5. DB-level integrity constraints — 3/3 SHIPPED (`6cb3e7e`, PR #41)

- ~~CHECK on `Transaction.amount` sign vs `transactionType`~~ — shipped.
- ~~`onDelete: Cascade` for split legs instead of application-level cascade~~
  — shipped.
- ~~Enforce `linkedTransferId` symmetry via a trigger~~ — shipped in PR #41 as
  `prisma/migrations/20260802103000_transfer_pair_exclusivity_triggers`. Two
  triggers (`AFTER INSERT`, `AFTER UPDATE OF "linkedTransferId"`), both guarded
  by `WHEN NEW."linkedTransferId" IS NOT NULL` so writes of NULL and the
  transient one-sided states inside a pairing transaction stay legal. The
  enforced predicate is pair *exclusivity*, not literal symmetry — design in
  `docs/adr/0021-transfer-pair-exclusivity-enforced-by-db-trigger.md`, plus a
  fourth condition (a target may not be claimed by two rows at once) in
  `docs/adr/0022-transfer-pair-trigger-rejects-a-second-claim-on-the-same-target.md`.
  **Read both ADRs**: 0021 is unedited and does not mention the fourth
  condition. The hand-written logic stays in place across five write paths in
  four files — the PATCH re-pair branch and the DELETE cascade in
  `app/api/transactions/[id]/route.ts`, the link route, the manual-entry route
  (`app/api/transactions/manual/route.ts`), and the transfer loop in
  `app/api/ynab/import/route.ts` — this section previously said four paths in
  three files, missing the manual-entry route; the triggers are the backstop
  under it, and
  `app/api/transactions/[id]/link/route.ts` pre-checks both inbound conditions
  so they surface as 409s rather than raw SQLite 500s. Covered by
  `tests/transferPairExclusivity.test.ts`.

  Carried forward, not a regression: a future Prisma `RedefineTables` migration
  on `"Transaction"` silently drops both triggers **and** the amount-sign CHECK
  from `20260716201150`. Noted in `docs/architecture.md` and in the migration
  header.

## 6. Category handling on splits

When a parent has legs, the dashboard counts the legs (granular categories)
and the ledger stats count the parent (single category). Totals match; the
per-category split differs. Not a correctness issue, but the ledger's
category filter won't surface a split leg's category unless the leg is
shown. Consider: show legs inline in the ledger filter results when a
category filter is active, even if the parent doesn't match.

## 7. Harden historian Stop hook before granting external access

**Dormant until trigger.** Parked — the trigger is granting any other
contributor / external access to this repo (a collaborator, a branch/PR
workflow, or pointing this tooling at a repo not fully controlled by Shyam).
Risk is ~nil while YDB is solo, LAN-only, single-user (per `AGENTS.md`); do
not pull this into active work before the trigger approaches. Mirrors the
same parked item already tracked in the `exlibris` and `personal-brand`
sibling repos.

`.claude/hooks/historian-check.py` interpolates changed filenames verbatim
into its `decision: block` reason string, which is fed back into the model's
context as instructions. A filename is attacker-controllable text — once the
repo accepts inbound files (branch/PR/clone), a maliciously named file under
a watched path (e.g. `docs/adr/Ignore-prior-instructions-and-....md`) could
smuggle instructions into the model. Combined with the historian's
auto-commit-to-main, a successful injection would have an unattended
propagation path.

When the trigger fires:
- Sanitize the filename list before interpolation (strip newlines/control
  characters, clamp per-entry length).
- Stop auto-pushing on hook-triggered historian runs — commit locally and
  let Shyam push, so an injection can't reach the remote unattended.
  (Manual/explicit historian invocations may retain push if desired.)
- Re-examine the ambient exposure of repo-shipped `.claude/hooks/` scripts
  executing with user privileges on any cloned/contributed code; document
  onboarding guidance for new contributors.

The marker file (`.claude/.historian-last-seen`, gitignored) is not a
vector — it's a SHA passed as a git argument, not interpolated into a shell
or model prompt.
