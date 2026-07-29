# Architecture

Owned by `@tech-lead`. This is the canonical technical reference for YDB; load-bearing decisions get
an ADR (`docs/adr/`), this doc summarizes the current state and points to them.

## Stack

Next.js + Prisma + SQLite. See `AGENTS.md` for the "not the Next.js you know" warning — check
`node_modules/next/dist/docs/` before writing framework code, this app tracks a version with
breaking API changes from training-data Next.js.

## Canonical invariants (do not break without an ADR)

| Invariant | Source |
|---|---|
| Money stored as integer cents, never floats | `lib/accounts.ts`, `docs/archive/IMPROVEMENT_PLAN.md` §4 |
| Asset/liability sign rules (`computeBalance`) | `lib/accounts.ts` |
| Read-only SQL guard on the chat/query path | `lib/prisma.ts` |
| LAN-only, no auth/multi-user | `docs/archive/IMPROVEMENT_PLAN.md` §4 |
| All LLM inference is self-hosted (Ollama); no ledger data, query result, or user question goes to a hosted inference API | `docs/adr/0006-local-only-llm-inference.md`, `lib/llm-config.ts` |
| WAL mode, `synchronous = NORMAL`, `busy_timeout = 5000`, FK on | `docs/archive/IMPROVEMENT_PLAN.md` Phase 0 |

## Integration boundary (ADR-0001 through ADR-0005)

YDB is otherwise a closed, LAN-only app with no standing external dependencies. The LLM path is part
of why that holds — chat and extraction both call a self-hosted Ollama, so no ledger data or user
question leaves the LAN (ADR-0006). The YNAB migration integration is the one exception, and it's
deliberately kept narrow:

- **Outbound-only.** YDB calls out to `api.youneedabudget.com`; nothing calls into YDB. No webhook
  receiver, no public endpoint, no inbound network surface added.
- **User-initiated in Phase 1** (ADR-0002) — a Settings action, not a cron job or server process.
  Automatic background sync is a distinct, dormant Phase 2. The action is
  `app/settings/_components/YnabImportManager.tsx`: map accounts → preview → confirm, with no write
  before the confirm step.
- **One-way.** Reads from YNAB, never writes back (ADR-0001).
- **Credential handling:** the YNAB personal access token is a secret — store it the same way other
  local secrets are handled in this app (env var / local config, never committed, never logged, never
  surfaced in error messages sent to the LLM chat path).
- **Idempotent by construction:** YNAB transaction IDs are persisted against the YDB rows they created
  so reruns never duplicate (mirrors the CSV import's re-import safety story).
- **Divergence is reported, never applied.** YNAB-side edits and deletions are detected and surfaced
  for manual reconciliation; the importer never updates or deletes a YDB row it previously created
  (ADR-0004). Detection compares against `Transaction.ynabFingerprint`, a frozen snapshot of the
  YNAB-native values written once at import and by no other write path, so a local ledger edit can
  never be mistaken for a YNAB-side change (ADR-0005). This is the property that makes the ADR-0002
  Phase 1→2 gate meaningful, so treat the write-once rule on that column as load-bearing.

## Known follow-ups outside this scope

Prior open items from the M1–M7 rework are tracked in `FOLLOWUPS.md` (transaction accuracy /
reimbursement-linking items) — unrelated to the YNAB integration, left as-is.

## Decisions since initial scoping

- **YNAB token storage: `.env` var, not Settings-stored.** Decided 2026-07-26. Matches how other
  local secrets are handled in this app; avoids building encrypted-at-rest token storage + a Settings
  UI for what's meant to be a temporary migration tool.

## Open questions

- None outstanding for Phase 1. The Phase 1→2 gate itself (ADR-0002) is the next thing that needs a
  decision, and it needs real usage data before it can be answered.
- **No eval harness exists for the chat/SQL path.** ADR-0006 rejects hosted inference partly on the
  grounds that local-model quality has never been measured, so any future argument to revisit it
  needs a harness first. Unowned and unscheduled — worth a ticket if the "Chat knowledge" initiative
  goes anywhere.
