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
| Read-only SQL guard on the chat/query path | `lib/prisma.ts`, `docs/adr/0007-chat-knowledge-injected-into-narration-only.md` |
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

## Chat pipeline and the read-only guard (ADR-0006, ADR-0007)

`app/api/chat/route.ts` runs two Ollama calls: SQL generation (temperature 0, one repair round-trip on
a SQLite error) and then streamed narration of the result rows. The guard is the boundary between them.

`executeReadonlyQuery` (`lib/prisma.ts`) is the whole safety story: a `readonly: true` SQLite
connection, a `SELECT`/`WITH` check, a forbidden-identifier list matched on token boundaries after
string literals and comments are stripped, and a 500-row cap. It is **input-agnostic** — it inspects
the SQL string it is handed and knows nothing about what prompted it. Its only two call sites are both
fed from `generateSql` output. Anything added to the narration side therefore cannot reach it, and
anything added to the SQL side cannot weaken it either; it would only degrade generated-SQL quality,
surfacing as more 422s. Keep both properties true: one guard function, no second execution path, and
no route that feeds narration output back into SQL.

Knowledge snippets (`docs/knowledge/`) are injected into the narration system prompt only (ADR-0007).
That directory is application input at code trust level — git-tracked, PR-reviewed, never a target for
ingested or scraped content.

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
  goes anywhere. ADR-0007 now leans on the same gap: with no harness there is no way to justify a
  conditional/retrieval layer over the flat P0 injection, so the harness gates that too.
- **Refusal happens after the query runs.** The boundary snippet `X1` lives in the narration prompt
  (ADR-0007), so an out-of-scope question still generates and executes a `SELECT` before the model
  declines. Read-only and local, so it costs latency rather than safety. Revisit only if a cheap
  pre-SQL scope check turns out to be worth the extra round-trip.
- **`num_ctx` is never set anywhere in the app.** Both chat calls and the extraction call run at
  Ollama's resolved default, and the narration prompt is only loosely bounded. Ticket 4 has to resolve
  this for narration; the extraction path (`app/api/ollama/route.ts`) has the same latent issue and
  nobody owns it.
