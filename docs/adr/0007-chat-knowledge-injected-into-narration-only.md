# ADR-0007: Chat knowledge is injected into the narration prompt only

Status: Accepted
Date: 2026-07-29

## Context

The "Chat knowledge" initiative produced 25 general personal-finance snippets in `docs/knowledge/`
(tickets 1–3), 12 of them `priority: P0, status: active` — 737 words, roughly 950–1,000 tokens.
Ticket 4 wires them into the chat pipeline. That means editing `app/api/chat/route.ts`, which sits on
the read-only SQL guard path (`lib/prisma.ts`, `docs/architecture.md`), so the ticket was blocked
pending this review.

The route runs two Ollama calls against one model (`chatModel`):

1. **SQL generation** — `SQL_SYSTEM_PROMPT` (a schema contract plus dialect and semantics rules),
   temperature 0, non-streaming. Output goes through a `^(SELECT|WITH)` regex, then
   `executeReadonlyQuery`. On a SQLite error the same prompt is re-sent once with the failure
   appended (a repair round-trip), so this prompt is billed up to twice per turn.
2. **Narration** — a short persona/formatting system prompt, streamed, with prior turns, the
   question, and up to 20 result rows as JSON in the `prompt` field.

`docs/knowledge/` is also the first content under `docs/` that is application input rather than human
reference. Its README already requires branch-and-PR for changes; this ADR is what makes that a
standing rule rather than a local convention.

## Decision

**Knowledge snippets are injected into the narration call's `system` field only. Nothing is added to
`SQL_SYSTEM_PROMPT` or the SQL prompt, on either the first pass or the repair pass.**

The SQL step is a constrained translation task at temperature 0 against a fixed schema. The snippets
supply interpretive vocabulary — sinking funds, avalanche versus snowball, lifestyle inflation — none
of which corresponds to a column, and several of which invite a model to invent one. Adding ~1,000
tokens of prose there dilutes the schema rules that keep generated SQL correct, and it pays that cost
twice on the repair path, for a step whose output is a SQL string that no user reads. Narration is
where the framing is actually used and where the cost is paid once.

The whole `P0` set goes in on every narration call. Ticket 4 was written before ticket 3 landed and
assumes a selection function returning 1–2 relevant snippets; ticket 3 then sized `P0` specifically so
that injecting all of it is affordable and no retrieval layer is needed to ship. The later decision
wins. A keyword matcher is a retrieval layer with no eval harness to show it picks correctly, it makes
the assistant's behaviour vary per turn for reasons that are hard to debug, and `X1` has to be exempt
from it regardless — so it buys inconsistency in exchange for tokens that ticket 3 already budgeted for.

The boundary snippet `X1` (scope and refusal) is injected with the rest, in narration. Refusal is
therefore post-execution: an out-of-scope question still generates and runs a `SELECT` before the
model declines. On a read-only connection with no egress (ADR-0006) that is wasted latency, not a
safety problem. Accepted for v1; recorded as an open question in `docs/architecture.md`.

## Consequences

**The read-only SQL guard is untouched.** Verified against the code, not assumed. `executeReadonlyQuery`
has exactly two call sites (`app/api/chat/route.ts:163` and `:193`), both fed only by `generateSql`
output. Narration runs strictly after execution and its output streams to the client; there is no path
from a narration token back into the guard. The guard is also input-agnostic — it inspects the SQL
string it is handed and knows nothing about what prompted it — so even injection into the SQL prompt
could not have weakened it. What that would have risked is a *quality* regression surfacing as more
422s, which is why the decision goes the other way anyway. Integer-cents money and the `lib/accounts.ts`
sign rules are likewise unaffected; the loader reads files and concatenates strings, it computes nothing.

**`docs/knowledge/` becomes a trusted input channel, at code trust level.** Text in that directory
reaches a model prompt on every chat turn. It is safe because it is git-tracked, hand-authored, and
PR-reviewed — not because anything sanitises it at runtime. The loader must read only that directory
and only the body above the first `##` (the README's injection rule). Ingested or scraped content must
never land there; that is already flagged in the README and this ADR makes it binding.

**Conditions on ticket 4's implementation.** `@backend-engineer` is cleared to build against these:

- **Filter:** `status: active` AND `priority: P0` — the 12 snippets. Keyword matching, retrieval, and
  conditional P1/P2 inclusion are out of scope; the storage convention was sized specifically so no
  retrieval layer is needed, and with no eval harness (`docs/architecture.md` § Open questions) there
  is no way to show conditional selection helps. Make the priority filter a parameter rather than a
  hardcoded `P0`, so lifting the P2 hold is a one-line change.
- **Order:** deterministic — by `id` ascending, with `X1` last so the boundary instruction sits nearest
  the operative rules. Non-deterministic ordering makes narration diffs unreadable.
- **Placement within `system`:** persona line, then the knowledge block, then the existing operative
  rules (use the data, currency formatting). Ollama drops from the front of the context window when a
  prompt overflows, so ordering is not cosmetic.
- **Precedence line, mandatory,** immediately before the block: the snippets are background vocabulary
  and must never override, contradict, or supplement the query result; anything the rows do not support
  is not to be asserted. This is README rule 3 and it is the difference between framing and fabrication.
- **Loading:** read at request time, no cache. Twelve files under 8 KB against a call with a 120-second
  timeout — caching buys nothing and costs a staleness bug class. On any read failure, log and inject
  nothing; degraded narration beats a failed chat turn.
- **`num_ctx`:** no call in this repo sets it, so both calls run at Ollama's resolved default. The
  narration prompt is already loosely bounded (8 history messages × 2,000 chars, plus 20 rows of
  pretty-printed JSON); +1,000 tokens on top makes silent truncation likelier, and truncation eats the
  front of the prompt — the system field, where the knowledge now lives. Ticket 4 must either set
  `num_ctx` explicitly on the narration call or record the resolved default and show the worst-case
  prompt fits under it.
- **Measurement is a deliverable.** The P2 hold on `D4`/`F2`/`F3` is gated on ticket 4 measuring real
  token cost. Report measured prompt tokens with and without the block; do not close the ticket on the
  estimate.

**Token budget:** ~1,000 tokens per narration call is accepted. It is a fraction of what 20 rows of
JSON already cost, it is paid once per turn rather than twice, and the ceiling is fixed rather than
scaling with data.

**Sequencing against two open tickets** (flagged, not scoped here). *chat-perf* (split `chatModel` into
`sqlModel` + `narrationModel`) is not a blocker and gets easier under this decision — narration-only
injection means the knowledge block travels with the narration role cleanly; whoever does that split
must keep it attached there. *chat-bug* (cents-vs-dollars determinism) touches the same narration system
string this ticket edits, specifically the "may already be dollars … or raw cents — infer from context"
clause that is the bug. Land chat-bug first if it is near-term. If ticket 4 goes first, it must not touch
that clause, and no injected snippet may introduce a currency-formatted figure — otherwise a determinism
regression becomes unattributable between the two changes.
