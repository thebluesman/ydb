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
| Transfer pairs are exclusive: no self-link, no stealing a taken counterpart, no orphaning an inbound pointer, no second claim on a target another row already names | `docs/adr/0021-transfer-pair-exclusivity-enforced-by-db-trigger.md`, `docs/adr/0022-transfer-pair-trigger-rejects-a-second-claim-on-the-same-target.md` |

### DB-level invariants on `"Transaction"` — re-create these on any table rebuild

Three constraints on `"Transaction"` are hand-written into migrations because Prisma's schema cannot
express them: the `amount` sign vs `transactionType` CHECK (in
`prisma/migrations/20260716201150_split_leg_cascade_and_check_constraint`), and the two transfer-pair
triggers from ADR-0021 (four conditions each, per ADR-0022). Prisma's `RedefineTables` strategy drops and rebuilds the table from its own
schema, so **any future migration that rebuilds `"Transaction"` silently drops all three.** Check for
them after generating such a migration and hand-edit them back in.

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

`POST /api/chat` answers with NDJSON on a 200 — one JSON object per line, five frame types live
today:

| Frame | Shape | Meaning |
|---|---|---|
| `sql` | `{ type: 'sql', sql }` | The query that ran. Always first when narration follows. |
| `result` | `{ type: 'result', present, currency, columns, rows, truncated }` | The result set, rendered structurally rather than as prose (ADR-0023). At most once per turn. |
| `suggestions` | `{ type: 'suggestions', questions: [{ text, template }] }` | Up to three route-templated follow-up questions (ADR-0024). At most once per turn; omitted entirely when no template's preconditions hold. |
| `token` | `{ type: 'token', response }` | A narration chunk. |
| `no-answer` | `{ type: 'no-answer', reason, message, sql?, questions? }` | A refusal (ADR-0014), optionally carrying ADR-0024 suggestions inline. |

**Frame order is `sql`, `result`, `suggestions`, then `token`s — the token stream is always last**
(ADR-0024). Everything after the prose begins is prose, so the client never resumes parsing once it
starts rendering escaped text. Adding another non-prose frame is cheap; adding a post-prose one is a
decision.

The `result` frame (ADR-0023) is one contract behind three Tier-1 output shapes from the
`[chat-model]` triage — table, stat card, annotated transaction list — distinguished only by a
`present` hint the **route** chooses from the returned rows, never by a marker the narration model
emits. It carries the same `rows` narration sees, after ADR-0017's row-key check and ADR-0020's
unit conversion and under the same `NARRATION_ROW_CAP`, so it adds no new SQL surface and no second
row path. It is emitted between `sql` and the first `token`, at most once per turn, and never
alongside a `no-answer` or an HTTP error.

The `suggestions` frame (ADR-0024) carries follow-up questions the route composes from a closed
template set. No model writes them: a suggestion is clickable, so it is an input path into the SQL
prompt, and text a model wrote from third-party-controlled rows is not one this app hands the user to
click. Slot values are limited to date ranges the route computed and to category/account literals
already inside ADR-0008/ADR-0018's injected vocabulary, so no new taint path opens. Every template
must produce a question the pipeline can actually answer — no balance questions (ADR-0015), no
compound selects (ADR-0011) — and an unresolvable query shape omits the frame rather than guessing.

Two sibling `[chat-model]` Tier 1 outputs need no wire change at all, recorded here rather than as
ADRs because neither is a decision:

- **Cross-reference to ledger/dashboard (output 10) is frontend-only.** The client builds the deep
  link from the `result` frame's `rows` — a `date` column links to the ledger filtered to that range,
  a `category` column to that category, an `id` column to that transaction — and from nothing else.
  It must not parse the `sql` frame to build a link: that would be a second, divergent implementation
  of the filter semantics the guards enforce, and a link that covers a different set than the number
  above it is ADR-0010's "a label is a claim" failure wearing a URL. If the rows don't carry the
  dimension, there is no link.
- **Narrative summary over a period (output 13) is a narration-prompt variant.** It is prose in the
  existing `token` stream, sitting beside PR 2's narration-voice setting rather than beside the frame
  contract. One constraint: a monthly recap is not a licence to raise `NARRATION_ROW_CAP`. A recap
  wants grouped aggregates — by month, by category — which is a SQL-shape question, not a
  narration-length one. Feeding the narrator more raw rows to make the paragraph richer would undo
  ADR-0023's one-row-set-one-cap property.

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
first time that has happened on this path. A fourth (ADR-0020) came out of implementation triage on
the units ticket, before any code was written:

- **A sign-branching aggregate with no `transactionType` predicate, and a bare `SUM(amount)` over
  transfer-pinned rows** (ADR-0016, detectors in `lib/chatMoneyGuards.ts`) — a transfer is two rows, so
  a bare sign split counts the outgoing leg as spending and the incoming leg as income, and a sum over
  transfers cancels to a confident zero. Refused as `unsupported-shape`. The other two money guards,
  split-leg and reimbursement, get no detector: applicability depends on what the question meant, so
  they stay prompt-only, held by a guard-matrix test over the prompt's worked examples.
- **`SELECT *` star-expanding `Account.openingBalance` past the text checks** (ADR-0017) — the column
  list of a star projection is not knowable from the query string, so the same balance-scope rules also
  run on the keys of the rows that came back. This was the only guard in the pipeline that ran after
  execution; ADR-0020 adds the second, and per ADR-0017 that is the signal to reconsider the phase
  ordering under ADR-0012's loop rather than to add a third.
- **A guessed account-name literal matching nothing** (ADR-0018) — ADR-0008's mechanism on
  `Account.name`, the column ADR-0008 explicitly scoped out. The `Account` qualifier is resolved off
  the statement's `FROM`/`JOIN` clauses rather than assumed, since `Category.name` also exists, and an
  unrecognised table-source shape fails open to a non-check.
- **Raw integer cents narrated as currency units** (ADR-0020, implemented `lib/chatMoneyUnits.ts`) —
  the SQL prompt's `/100.0` rule is scoped to aggregates, so a row-level `Transaction.amount` or an
  `Account.creditLimit` reached narration as raw cents under a prompt clause telling the narrator to
  "infer from context". Units are a static property of schema columns, so the server classifies the
  final `SELECT`'s projection list and divides the resolved values before narration; a projection it
  can't resolve (a CTE, an ambiguous star, a money expression with no `/100` in a shape it recognises)
  is refused as `unsupported-shape` rather than guessed. **Explicitly not an arithmetic-correctness
  check** — a projection that already contains `/100` is trusted as converted even if the surrounding
  expression computes the wrong number (misplaced or redundant unit conversion inside a derived ratio,
  live-reproduced during the `[chat-bug]` derived-values re-scoping, 2026-08-03). That is a correctness
  question the units classifier cannot and does not try to answer; only the eval harness below can.

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
`computeBalance`), which is what finally closes the balance gap ADR-0010 declines. Phase A is now
**built and shipped** (see below); B and C remain dormant in the ADR-0002 sense — Phase A existing is
not the same claim as Phase A's gate condition being satisfied.

**Phase A shipped 2026-08-04** (PR #52, `6fb77c8`), implementing the design **ADR-0025**/**ADR-0026**
fixed the same day. The verdict is three labels the model may emit — `ok`, `mismatch`, `out-of-scope` —
plus an `unusable` the route assigns when the verifier call fails; deliberately its own type rather than
ADR-0014's `NonAnswerReason`, because a model's opinion about a result and a route's deterministic
refusal are different claims and the data has to tell them apart. A `mismatch` verdict must name which
of three checks failed (`Filter:`/`Label:`/`Shape:`) or the route downgrades it to `ok` — a verdict that
can't say what's wrong isn't evidence. It runs on `sqlModel` at `SQL_NUM_CTX` (no new Settings key, no
runner reload) with its own 20s timeout, and it is **the one guard in this pipeline that fails open**:
an unavailable second opinion is not evidence against an answer already in hand — a transport failure,
timeout, or malformed response all resolve to `unusable`, which the route treats exactly like `ok`.
**ADR-0026** puts the verdict record in its own `ChatVerdict` table (`lib/chatVerification.ts`,
`app/api/chat/route.ts`) written by the route, not on `ChatMessage` — `/api/chat` receives no session id
and message rows are written by the client after the stream, so a verdict routed that way is lost on
exactly the turns worth studying. That table is what ADR-0013's Phase B gate gets read from, and
`[chat-model]` Tier 2 sits behind it — but the gate isn't satisfied by the table merely existing; see the
open question below on the verifier's own unmeasured accuracy.

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
- **A golden-query eval harness exists now** (`[chat-eval]`, `scripts/evalChatSql.ts` +
  `scripts/chatEval/`, shipped 2026-08-03) — this entry previously read "no eval harness exists ... the
  single most blocking gap." It runs ~22 natural-language questions against a small fixture ledger
  through the real prompt and real guard chain, on a real Ollama call, and reports pass/fail against a
  ground-truth SQL query per question (not a string match). Baseline run against `qwen2.5:32b`:
  **20/22 (90.9%)**. Two genuine findings, not harness bugs, neither fixed yet — full detail in
  `scripts/chatEval/README.md`: (1) a bare "total income" question drops the reimbursement-settlement
  exclusion that the paired income-and-expenses worked example correctly teaches, over-reporting by the
  settlement amount; (2) a transfer-category question ("how much did I pay on my car loan") sometimes
  combines an account-name filter with the category filter, and since a transfer's category lives on
  only one leg (ADR-0019) that intersection can be empty — open whether this is a model-reasoning gap or
  a fixture question inviting an over-constrained reading.
  **What this unblocks:** ADR-0006's hosted-inference rejection can now be argued from measured data
  rather than absence of measurement (though 20/22 on one model isn't yet grounds to revisit it). ADR-0007
  can be evaluated for whether a retrieval layer beats the flat P0 injection. ADR-0013's Phase B gate
  and the untried `qwen3.6:latest` comparison both have a harness to run against, though nobody has run
  either comparison yet — the harness existing is not the same as the four decisions being answered.
  **Known limitation, stated in the harness's own README:** it reimplements route.ts's guard order as a
  thin driver calling the same guard functions live from `lib/`, not the route handler itself (which
  would require pointing at `prisma/dev.db`'s hardcoded path, exactly what this harness must not risk
  touching) — guard *logic* cannot drift out of sync, guard *order* or a newly-added guard could.
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
  reaches narration unchallenged. **Updated 2026-08-04:** both things this entry said did not exist now
  do — the eval harness shipped, and the ADR-0025 verifier (`lib/chatVerification.ts`, shipped same day,
  PR #52) is live in the running pipeline, aimed squarely at this class ("does each column's label
  describe what its expression computes"). It is a mitigation, not a closure: the verifier is the same
  local model and fails open, so an unchallenged figure is now less likely rather than impossible. The
  real closure is still the `computeBalance` path above.
- **The Phase A verifier's accuracy has now been measured, and it is not high enough to be a settled
  question.** `scripts/evalChatVerifier.ts` (new, 2026-08-04) runs the verifier against golden-query
  ground-truth SQL (expect `ok`) and hand-written broken SQL (expect `mismatch`/`out-of-scope`), on
  `qwen2.5:32b`. Combined pipeline result (route guard + model): **0.59 precision, 0.91 recall**, on 19
  good / 11 broken fixture cases. The measurement surfaced a real deterministic-guard addition along the
  way — `signPromiseViolation` (ADR-0025's addendum) — which alone scores 1.00/1.00 and is reported
  separately from the model's own 0.56 precision / 0.90 recall, so a future guard addition cannot
  inflate "verifier accuracy" without the model's own judgment improving. **Since a `mismatch` refuses
  the turn outright, ~0.56-0.59 precision means roughly two-in-five flags on genuinely correct SQL are
  false alarms — a real usability cost, not just a research number.** Whether that clears ADR-0013's
  Phase B gate is Shyam's call and is explicitly not decided here; see ADR-0025's addendum for the full
  breakdown and the two prompt-wording attempts that made precision worse before the deterministic fix
  made it better.
- **Whether guard refusals should also land in `ChatVerdict`.** ADR-0026 records only turns that
  reached the verifier, so the full outcome distribution is split between that table and
  `ChatMessage.nonAnswerReason` and can only be joined by hand on timestamps. Deliberately left open:
  several guards refuse before any SQL exists, so giving one table the whole distribution is a larger
  change than it looks.
- **How much of `accountNameScope`'s fail-open surface is real?** ADR-0018 closed the account-name
  grounding gap this entry used to describe, but its `Account`-qualifier resolution is a regex over
  `FROM`/`JOIN` and deliberately fails open: a CTE or an unusual join shape is silently not checked.
  Nobody has measured which shapes the model actually produces, so the size of the remaining hole is
  unknown. The eval harness above is what would answer it. **Narrowed 2026-08-01:** all 5 persisted
  `ChatMessage.sql` rows — the entire live sample — reference `Account` zero times, so the fail-open
  path has never fired, and the surface question is genuinely unmeasured rather than known-large.
  Two separate things were then found, and they should not be conflated:

  1. *A prompt gap, since closed (PR #38).* `lib/chatSqlPrompt.ts` prose-instructed the join rule
     (`"Transaction".accountId = Account.id`) with no worked example, while categories got three.
     Few-shot shape beats prose (ADR-0008), so the model had no shape to imitate for the one construct
     this guard reads. An aliased worked example was added — no ADR, it implements ADR-0018.
  2. *A bug in the resolver, fixed 2026-08-03 ([chat-sql] 9, PR #42).* The fail-open surface was **not**
     the exotic shapes ADR-0018 described as "a CTE or an unusual join form" — it was the plainest join
     the model can write. `TABLE_SOURCE_RE` in `lib/chatAccountVocabulary.ts` gave the alias slot an
     unconditional `\s+identifier` match, so on an **unaliased** source the alias slot consumed the
     following `JOIN`/`FROM` keyword itself. `NOT_AN_ALIAS` correctly declined to bind it as an alias,
     but the regex's `lastIndex` had already advanced past it, so the *next* table source was never
     matched at all. Two distinct symptoms, both pinned as tripwires in
     `tests/chatSqlPromptAccountJoinExample.test.ts` (six shapes plus two aliased controls), now flipped
     to passing assertions: `FROM "Transaction" JOIN Account …` used to silently register no `Account`
     qualifier and go unchecked (fail-open); `FROM Account JOIN "Transaction" …` used to lose the second
     table, so `tables.size === 1` and `bareNameIsAccount` wrongly returned true, refusing a bare `name`
     that belonged to the other table (false ADR-0014 refusal). Fixed with a negative lookahead
     excluding JOIN and its modifiers (LEFT/RIGHT/INNER/OUTER/CROSS/NATURAL/FULL) from the alias slot,
     so the keyword is left for the next `matchAll` iteration instead of being consumed. **Still open,
     a distinct and unrelated limitation:** comma joins (`FROM "Transaction", Account`) are still missed
     regardless of aliasing, because the regex anchors on `FROM`/`JOIN` only and `,` is not a
     source-introducing token — not touched by this fix, pinned as its own tripwire. `lib/chatMoneyUnits.ts`
     (ADR-0020) reuses this same fixed idiom rather than the pre-fix one, so it does not inherit the bug.

  The harness question stays open regardless: it is what would say how often the model writes the
  affected shapes, which is a different question from whether the resolver handles them.
- **How often does the model write a projection ADR-0020's classifier cannot resolve?** ADR-0020 fails
  *closed*, refusing CTEs, projection subqueries and stars over a CTE or a multi-table join as
  `unsupported-shape`, on the reasoning that none of the SQL prompt's nine worked examples uses one and
  the refusal rate should be near zero. That is an argument, not a measurement, and it is the opposite
  posture from ADR-0018's fail-open on a similar resolution problem. The same `ChatMessage.sql` /
  eval-harness work that would size ADR-0018's hole would size this one. If refusals turn out to be
  common, the answer is to widen the classifier, not to fail open.
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
- **Structured chat output has two questions ADR-0023 deliberately left open.** (1) Whether a `result`
  frame's display cap may exceed `NARRATION_ROW_CAP` (20) — ADR-0023 ties them together so the table
  can never show rows the sentence above it was not written from, but an audit list is exactly the case
  that wants more rows. (2) Where structured output persists: `ChatMessage` stores `text`/`sql`/
  `nonAnswerReason` and no rows, so a table vanishes on reload. Adding a column is its own ADR; the one
  constraint ADR-0023 fixes in advance is that a persisted frame is stored verbatim and never rebuilt by
  re-executing `ChatMessage.sql`, which would be a row path reaching the client without the guard chain.
- **`num_ctx` is set on the two chat calls and nowhere else.** Ticket 4 resolved it for narration
  (`NARRATION_NUM_CTX` = 16,384) and the SQL call followed (`SQL_NUM_CTX`), both in
  `app/api/chat/route.ts`. The extraction path (`app/api/ollama/route.ts`) still runs at Ollama's
  resolved default with a prompt sized by whatever statement text was uploaded, and nobody owns it.
- **How far `narrationModel` can be sized down is unknown, and it is coupled to the knowledge block.**
  The `sqlModel`/`narrationModel` split exists so narration can run something smaller, but
  `NARRATION_NUM_CTX` (16,384) is validated only against the two recommended chat models, both ≥32k
  native. A smaller narration model with a shorter native context brings back the silent
  front-of-prompt truncation ADR-0007 flagged — at the position the injected knowledge block occupies,
  whose ~1,000 tokens are a fixed cost that grows in relative weight as the model shrinks. So "how
  small can narration go" and "how much knowledge does it carry" are one question. See ADR-0007's
  2026-08-01 addendum. The eval harness above is what would answer it; a guessed parameter floor would
  be the fifth unmeasured heuristic in this pipeline, and three of the previous four were falsified by
  live sessions.
