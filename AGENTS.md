<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Before making changes, read IMPROVEMENT_PLAN.md

`IMPROVEMENT_PLAN.md` was the authoritative code/product/UX review and phased roadmap for the M1–M7
UI/reliability rework. **That work is complete and the doc is archived** at
`docs/archive/IMPROVEMENT_PLAN.md` — kept for historical reference, no longer live. Its do-not-break
invariants (integer-cents money, sign/type rules in `lib/accounts.ts`, the read-only SQL guard) still
apply; they're now tracked in `docs/architecture.md`.
<!-- END:nextjs-agent-rules -->

# YDB — Claude Code Workspace

YDB is Shyam's personal finance app (Next.js + Prisma + SQLite, LAN-only, single-user). The M1–M7
rework (ledger performance, dashboard, mobile, data integrity, CSV import, a11y) is done and archived
at `docs/archive/IMPROVEMENT_PLAN.md`.

## Current phase

**Migration project — Phase 1 (YNAB → YDB manual import), active as of 2026-07-26.** Shyam wants to
stop paying for YNAB and migrate to YDB. The transition: an external SMS→Signal→YNAB capture pipeline
(outside this repo) keeps YNAB current, and this repo pulls that data into YDB one-way so Shyam can
validate YDB against real daily use before cancelling YNAB. See `docs/prd.md`.

Phases:

- **Phase 1 (active):** manual "Import from YNAB" Settings action. `@backend-engineer` active;
  `@tech-lead` owns the integration ADRs; `@qa` verifies idempotency and mapping correctness.
- **Phase 2 (dormant):** automatic background sync, replacing the manual button. Gated on an explicit
  trust trigger — see ADR-0002's activation checklist. Not started.

Phase 1 → Phase 2 gate: Phase 1 in daily use for at least a few weeks with no mis-mapped transactions,
and Shyam explicitly declares the trigger met (his call, not a timer).

## Canonical decisions

| Decision | Value | Source |
|---|---|---|
| Money representation | Integer cents, never floats | `lib/accounts.ts` |
| Asset/liability sign rules | `computeBalance` in `lib/accounts.ts` | `docs/architecture.md` |
| Read-only SQL guard on chat/query path | `lib/prisma.ts` | `docs/architecture.md` |
| App posture | LAN-only, no auth/multi-user | `docs/architecture.md` |
| YNAB integration scope | One-way pull only, YDB never writes to YNAB | `docs/adr/0001-ynab-integration-scope.md` |
| YNAB rollout sequencing | Manual import (Phase 1) before automatic sync (Phase 2) | `docs/adr/0002-manual-import-before-auto-sync.md` |
| LLM inference scope | Local only (Ollama), no hosted/third-party LLM API in the chat path | `docs/adr/0006-local-only-llm-inference.md` |
| Chat knowledge injection point | Narration prompt only, never the SQL-generation prompt | `docs/adr/0007-chat-knowledge-injected-into-narration-only.md` |
| Chat target architecture | Bounded agentic loop; `run_sql` via `executeReadonlyQuery` is the only execution tool | `docs/adr/0012-agentic-chat-loop-target-architecture.md` |
| Chat rollout sequencing | Verification pass (A) → single-tool loop (B) → code-computed tools (C); only A is unblocked | `docs/adr/0013-verification-pass-before-tool-calling-loop.md` |
| Chat non-answers | First-class `no-answer` stream type with a reason, never an HTTP error or a confident zero; `out-of-scope` = the question can't be answered, `unsupported-shape` = the generated query can't be trusted | `docs/adr/0014-non-answer-is-a-first-class-chat-response.md` |
| Chat SQL scope | No balances or net worth (declined, not approximated); no compound SELECTs (`UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT`) | `docs/adr/0015-balance-scope-enforced-on-the-question.md`, `docs/adr/0011-chat-sql-no-union-compound-selects.md` |
| Balance-scope enforcement point | The user's question, before SQL is generated; ADR-0010's alias check kept as a second net | `docs/adr/0015-balance-scope-enforced-on-the-question.md` |
| Chat SQL category filters | Grounded in stored `Transaction.category` values; unmatched category fails loudly | `docs/adr/0008-chat-sql-category-vocabulary-grounding.md` |
| Chat SQL and account balances | `openingBalance` off-limits to generated SQL; balance/net-worth questions declined, not guessed | `docs/adr/0009-balance-composition-out-of-scope-for-chat-sql.md` |

## Team (subagents)

| Agent | Owns | When to invoke |
|---|---|---|
| `@tech-lead` | `docs/architecture.md`, `docs/adr/` | Architecture decisions, ADR authoring, integration design |
| `@backend-engineer` | YNAB integration code | Phase 1 import implementation (active); Phase 2 sync (dormant until trigger) |
| `@product-manager` | `docs/prd.md`, Notion Kanban | Scoping/sequencing tickets for the migration project |
| `@qa` | Test strategy for the import | Idempotency, mapping-correctness, regression checks before either phase ships |
| `@historian` | `docs/journal/` | Logs decisions after canonical-doc edits |

## Key references

- Product spec: `docs/prd.md`
- Architecture: `docs/architecture.md`
- ADRs: `docs/adr/`
- Project journal: `docs/journal/` — owned by `@historian`
- Chat knowledge snippets: `docs/knowledge/` — **runtime prompt input, not documentation**; read
  `docs/knowledge/README.md` before editing anything in there
- Archived rework plan: `docs/archive/IMPROVEMENT_PLAN.md`
- Prior open follow-ups (unrelated to migration): `FOLLOWUPS.md`
- Design conventions: `Design Guide.md`

## Output format rule

**All documentation is `.md`.** When an agent produces a deliverable, it writes to `docs/` as markdown.

## Bash hygiene — git invocations

**Prefer bare `git <subcommand>`. Never chain `cd <path> && git ...`.** Every agent operating in this
repo is already in the project root; `git` operates on the current working tree without help.

## Git workflow

Solo contributor — for code changes, standard branch + PR still applies (this is a code repo, not a
docs-only workspace like exlibris/personal-brand). For doc-only changes inside `docs/` (ADRs, journal,
PRD, agent definitions), committing directly to `main` is fine — no other writer to collide with.

## MCP connections

- **Notion** — Kanban board for the migration project, nested under the existing "ydb" page
  (`https://app.notion.com/p/33da225a2512804d98e1db881dc1b2c4`). Board: "YDB Migration — Tickets".
  Data source ID: `fe3ba716-d772-48be-acaf-20601c1638c3`.
