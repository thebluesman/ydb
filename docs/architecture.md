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

### Chat wire format

`POST /api/chat` answers with NDJSON on a 200 — one JSON object per line, three frame types:

| Frame | Shape | Meaning |
|---|---|---|
| `sql` | `{ type: 'sql', sql }` | The query that ran. Always first when narration follows. |
| `token` | `{ type: 'token', response }` | A narration chunk. |
| `no-answer` | `{ type: 'no-answer', reason, message, sql? }` | A refusal (ADR-0014). |

`no-answer` reasons are `out-of-scope`, `no-data`, `unsupported-shape`, `budget-exhausted`
(`lib/chatNonAnswer.ts` is the single definition; adding one is a line there plus a headline). Its
`message` is written by the route, never by the model — a decline the model phrases is a decline the
model can talk itself out of. Its `sql` is the same field the `sql` frame carries, not a second
SQL-bearing key. A `no-answer` arrives alone: nothing narrates after it.

HTTP errors (`{ type: 'error', message, sql? }` on 400/422/503) are now reserved for transport and
unexpected faults — an unreachable Ollama, a SQLite failure that survived the repair round-trip. A
refusal is never one. Two reasons are wired live today: `no-data` (a clean run matching nothing, or an
all-`NULL` aggregate row — the confident-zero bug) and `unsupported-shape` (generation returned a
non-`SELECT`). ADR-0008/0010/0011 add their own triggers to the same frame.

Refusals persist to `ChatMessage.nonAnswerReason`, so they survive reload and appear in the session
history regression fixtures are built from. Genuine errors stay transient.

Knowledge snippets (`docs/knowledge/`) are injected into the narration system prompt only (ADR-0007).
That directory is application input at code trust level — git-tracked, PR-reviewed, never a target for
ingested or scraped content.

The guard is a safety boundary, not a correctness one. Manual testing on 2026-07-29 found three ways
the SQL step produces a well-formed, safely-executed, wrong answer, and all three are fixed on the
generation side, in `app/api/chat/route.ts` and deliberately not in `lib/prisma.ts`, so the guard stays
input-agnostic and single-purpose:

- **A guessed category literal matching nothing** (ADR-0008) — real `Transaction.category` values are
  injected into the SQL prompt as a closed list.
- **A transaction sum served as an account balance** (ADR-0010, superseding ADR-0009) — `SUM(amount)`
  over a liability account is net flow, not `computeBalance`'s `openingBalance − Σ amount`. Balance and
  net-worth questions are declined until a `computeBalance`-backed path exists, enforced by rejecting
  both `openingBalance` references and balance-claiming result aliases.
- **A compound SELECT collapsing two aggregate labels into one** (ADR-0011) — SQLite names a compound
  result set after its first branch, so an income sum reached narration labeled as expenses. `UNION`,
  `UNION ALL`, `INTERSECT` and `EXCEPT` are all rejected (ADR-0011 addendum); multi-metric answers use
  multiple aliased columns in one row.

Three more were found by the 2026-07-30/08-01 fixture work rather than by a live session, which is the
first time that has happened on this path:

- **A sign-branching aggregate with no `transactionType` predicate, and a bare `SUM(amount)` over
  transfer-pinned rows** (ADR-0016, detectors in `lib/chatMoneyGuards.ts`) — a transfer is two rows, so
  a bare sign split counts the outgoing leg as spending and the incoming leg as income, and a sum over
  transfers cancels to a confident zero. Refused as `unsupported-shape`. The other two money guards,
  split-leg and reimbursement, get no detector: applicability depends on what the question meant, so
  they stay prompt-only, held by a guard-matrix test over the prompt's worked examples.
- **`SELECT *` star-expanding `Account.openingBalance` past the text checks** (ADR-0017) — the column
  list of a star projection is not knowable from the query string, so the same balance-scope rules also
  run on the keys of the rows that came back. This is the only guard in the pipeline that runs after
  execution, and per ADR-0017 that exception should stay singular.
- **A guessed account-name literal matching nothing** (ADR-0018) — ADR-0008's mechanism on
  `Account.name`, the column ADR-0008 explicitly scoped out. The `Account` qualifier is resolved off
  the statement's `FROM`/`JOIN` clauses rather than assumed, since `Category.name` also exists, and an
  unrecognised table-source shape fails open to a non-check.

The balance-alias (ADR-0010) and compound-SELECT (ADR-0011) fixes share a root cause worth stating
plainly: narration receives `JSON.stringify(rows)` and nothing else, so the column alias — written by
the model at inference time — is the only thing carrying meaning, and it is a claim rather than a
description. Both fixes police that claim. ADR-0017 is the same rule reaching the labels the model did
*not* write: a star projection's columns are named by the schema, and narration cannot tell the
difference.

These diagnoses came from `ChatMessage.sql`, which persists every generated query. It is the first
place to look when a chat answer is wrong; ADR-0009 was written without it and misdiagnosed the bug.

### Direction: from single-shot to a bounded agentic loop (ADR-0012 → 0014)

The three bugs above share an architectural cause, not just a code cause: the pipeline produces one
query, trusts whatever comes back, and narrates it. It cannot inspect its own intermediate result. The
target architecture is a bounded ReAct-style loop over Ollama's tool-calling endpoint, with
`run_sql` — backed by `executeReadonlyQuery` and nothing else — as the only execution tool (ADR-0012).
Tool-calling is available on this install today; `qwen2.5:32b` advertises it and returns well-formed
calls in ~7s.

The guard survives this unchanged and becomes more load-bearing: it is input-agnostic, so N calls per
turn are as safe as one, but the loop must never open a second execution path, and the 500-row cap
needs a cumulative per-turn row budget beside it. ADR-0008/0010/0011 stay as defense-in-depth — a loop
cannot recover a label SQLite already destroyed (ADR-0011), nor independently check a claim the model
makes about its own output (ADR-0010).

Sequencing is three gated phases (ADR-0013): **A** — a verification pass between execution and
narration, which fits today's architecture and generates the eval data the chat path has never had;
**B** — the single-tool loop, where ADR-0007 gets superseded because a loop has one message thread
rather than separate SQL and narration prompts; **C** — code-computed tools (`get_balances` over
`computeBalance`), which is what finally closes the balance gap ADR-0010 declines. Only Phase A is
unblocked; B and C are dormant in the ADR-0002 sense.

Across all phases, declining is a normal outcome: a `no-answer` stream type with an explicit reason
(`out-of-scope`, `no-data`, `unsupported-shape`, `budget-exhausted`), distinct from an HTTP error
(ADR-0014). Exhaustion is counted by the route, not self-reported by the model.

**The honest constraint.** ADR-0006 caps this, and it bites on loop control rather than SQL syntax.
Probed 2026-07-29: handed back a `null` result, `qwen2.5:32b` noticed and retried, but retried by
adding a date filter instead of questioning the category literal that caused the null — it narrowed the
wrong axis. So the loop's value is that the model gets to *look*, not that it reasons its way out.
Chat's realistic ceiling here is reliable and willing to say "I don't know", not Claude/GPT-4 fluency
on open-ended financial reasoning.

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
- **No eval harness exists for the chat/SQL path — now the single most blocking gap.** ADR-0006 rejects
  hosted inference partly on the grounds that local-model quality has never been measured, so any
  future argument to revisit it needs a harness first. ADR-0007 leans on the same gap: no harness means
  no way to justify a retrieval layer over the flat P0 injection. ADR-0013 adds two more — it gates
  Phase B on Phase A's verdict data, and it is why `qwen3.6:latest` (installed, reports `thinking` and
  `tools`, 262k context) has not been tried as the chat model despite being free to evaluate. Four
  decisions now wait on this. Still unowned; ADR-0013's Phase A produces it as a side effect, which is
  the current best argument for doing Phase A first.
- **Refusal happens after the query runs — except for balance questions.** The boundary snippet `X1`
  lives in the narration prompt (ADR-0007), so a generally out-of-scope question still generates and
  executes a `SELECT` before the model declines. Read-only and local, so it costs latency rather than
  safety. ADR-0015 answered this for the one class where post-hoc refusal was producing wrong numbers
  (balance / net worth); whether the rest of `X1`'s boundary moves pre-generation the same way is still
  open, and ADR-0007's loop question below probably subsumes it. ADR-0017 deliberately moves one guard
  the *other* way — the star-expansion balance check can only run post-execution — so "everything
  refuses pre-generation" is no longer the target state; "nothing narrates before it is judged" is.
- **No code-computed balance path for chat, and it is now the priority.** ADR-0010 and ADR-0015 decline
  balance and net-worth questions rather than letting generated SQL assert a balance it cannot compute.
  Answering them properly means computing balances in code via `computeBalance` and handing the result
  to the model as data — ADR-0013's Phase C (`get_balances` as a tool). Three successive mechanisms for
  one scope decision (input column, output label, question wording) have each been falsified by a live
  session, because nothing in the pipeline represents stock-versus-flow. ADR-0015 is the last cheap
  proxy; a fourth heuristic is not the answer if it needs an exception.
- **Nothing verifies that a returned figure means what narration says it means.** ADR-0015 refuses
  questions that ask for a stock, and ADR-0010's alias check refuses SQL that claims to return one, but
  a balance computed under a neutral alias in answer to a question that named no stock noun still
  reaches narration unchallenged. Closing it needs the `computeBalance` path above or an eval harness;
  neither exists.
- **How much of `accountNameScope`'s fail-open surface is real?** ADR-0018 closed the account-name
  grounding gap this entry used to describe, but its `Account`-qualifier resolution is a regex over
  `FROM`/`JOIN` and deliberately fails open: a CTE or an unusual join shape is silently not checked.
  Nobody has measured which shapes the model actually produces, so the size of the remaining hole is
  unknown. The eval harness above is what would answer it. **Narrowed 2026-08-01:** all 5 persisted
  `ChatMessage.sql` rows — the entire live sample — reference `Account` zero times, so the fail-open
  path has never fired, and the surface question is genuinely unmeasured rather than known-large. A
  contributing cause was found and is separately fixable: `lib/chatSqlPrompt.ts` prose-instructs the
  join rule (`"Transaction".accountId = Account.id`) with no worked example demonstrating it, while
  categories get three. Few-shot shape beats prose (ADR-0008), so the model has no shape to imitate for
  the one construct this guard reads. Adding an example whose join shape `accountNameScope`'s
  `FROM`/`JOIN` resolver actually recognises is a `@backend-engineer` prompt ticket — no ADR, it
  implements ADR-0018 rather than changing it. The harness question stays open regardless.
- **ADR-0016's sign-branch detector is satisfied by a `transactionType` comparison anywhere in the
  statement**, including one inside a subquery that does not govern the sign branch. Under-detects
  rather than over-rejects, needs a real parser to close, and has not been seen live (ADR-0016
  addendum). Left open rather than fixed. **Re-checked 2026-08-01 and unchanged:** none of the 5
  persisted `ChatMessage.sql` rows contains a subquery, CTE or join, so the blind spot is still real by
  code inspection and still has zero live occurrences. Parked status confirmed; no action.
- ~~**Can a transfer leg carry a spend category?**~~ **Answered yes, 2026-08-01 — see ADR-0019.**
  Measured against `prisma/dev.db`: all 44 transfer rows carry a nonempty category, 5 of them a real
  spend category (`🚗 Auto loans`, `💰 Personal loans`), on the outgoing leg only. The transfer rule's
  trigger widens from "branches on the sign of amount" to any spending/income/net-flow aggregate,
  category-filtered ones included. It stays prompt-only: the mirror case ("how much did I pay on my car
  loan") wants exactly those rows, which is the question-dependence ADR-0016 split on. The prompt edit
  and the guard-matrix widening are a `@backend-engineer` ticket. Residual left open by ADR-0019: the
  set of categories the pipeline assigns to transfers is not fixed and not this repo's to control, so
  the mirror case's fragility persists until a code-computed path (ADR-0013 Phase C) exists.
- **ADR-0007's injection point has no answer under a loop.** A tool-calling loop has one message thread,
  so "the narration prompt" stops existing as a distinct site. The `X1` boundary snippet probably wants
  to move earlier — which would close the "refusal happens after the query runs" question above for
  free — while the interpretive snippets probably still should not shape SQL. Deliberately undecided
  until Phase B, when the loop's actual message structure is known. It needs a superseding ADR then,
  not an edit to ADR-0007.
- **The cumulative per-turn row budget (ADR-0012) has no number.** Four queries at the existing 500-row
  cap is 2,000 rows of context, which the single-shot path could never produce. `NARRATION_ROW_CAP` is
  20 today; what the equivalent whole-turn ceiling should be is unmeasured and depends on Phase B's
  real prompt sizes.
- **`num_ctx` is never set anywhere in the app.** Both chat calls and the extraction call run at
  Ollama's resolved default, and the narration prompt is only loosely bounded. Ticket 4 has to resolve
  this for narration; the extraction path (`app/api/ollama/route.ts`) has the same latent issue and
  nobody owns it.
