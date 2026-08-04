# ADR-0025: The Phase A verifier returns a three-label verdict on its own type, and fails open

Status: Accepted
Date: 2026-08-04

## Context

ADR-0013 made Phase A — one non-streaming model call between execution and narration — the next thing
to build, and sketched a four-way verdict: answers the question / wrong shape or label / no usable
data / out of scope. It was never built. Shyam wants `[chat-model]` Tier 2, Tier 2 needs Phase B, and
ADR-0013 gates Phase B on Phase A's verdict data, so Phase A is now on the critical path rather than
merely next.

Two things have changed since ADR-0013 and both bear on the design:

- **The eval harness now exists** (`scripts/chatEval/`, shipped 2026-08-03). ADR-0013 was written on
  the premise that nothing could measure the chat path. The harness measures the *pipeline* against
  fixture questions with ground-truth SQL; Phase A labels *real turns against the real ledger*, which
  the harness cannot. They are complements, not substitutes — but the harness can now also measure the
  verifier itself, which ADR-0013 could not assume.
- **`isNoDataResult` already owns emptiness** (`lib/chatNonAnswer.ts`), upstream of where the verifier
  runs. Zero rows and all-NULL rows never reach it. So ADR-0013's "no usable data" verdict has almost
  no residue: rows that exist, are non-NULL, and still do not bear on the question are not a distinct
  failure — they are a query that answered a different question.

What ADR-0013 left genuinely open is the label set, and what happens when the verifier itself fails.

## Decision

**Three labels the model may emit, one the route assigns, on a verifier-specific type — not
`NonAnswerReason`.**

- **`ok`** — these rows answer the question that was asked.
- **`mismatch`** — the rows are real and answer a *different* question: wrong period, wrong filter,
  wrong grain, or a column label that misdescribes what its expression computes. This absorbs both
  ADR-0013's "wrong shape or label" and its "no usable data".
- **`out-of-scope`** — nothing in this ledger answers this question; no rewrite of the SQL helps.
- **`unusable`** — never emitted by the model. Assigned by the route when the verifier call fails,
  times out, or returns something the format constraint did not pin down.

`mismatch` maps to ADR-0014's `unsupported-shape` and `out-of-scope` to its `out-of-scope`, per that
ADR's addendum discriminator: what failed, the question or the artifact. `ok` and `unusable` narrate.
That mapping is a total function in code and is the only place the two vocabularies meet.

**The verdict does not reuse `NonAnswerReason`,** because the two are different kinds of claim. A
`NonAnswerReason` is what the route decided to tell the user, from a property of the SQL text it
checked deterministically. A verdict is one local model's opinion about a result set, from a model
that shares the generator's blind spots. Sharing a type would make the captured data (ADR-0026) unable
to separate "a guard refused" from "a model guessed" — which is precisely the question ADR-0013's
Phase B gate asks.

**It fails open.** Every other guard in this pipeline fails closed (ADR-0020 most explicitly); this one
deliberately does not. Those guards decide a property of an artifact we hold. This one asks for a
second opinion, and an unavailable second opinion is not evidence against an answer already in hand. A
verifier outage that turned every answer into "Result not trustworthy" would be a worse failure than
the one Phase A exists to fix. `unusable` is recorded rather than swallowed, so the rate is visible.

**What the verifier sees, and how it is asked.**

- Input: the same history-prefixed question the SQL prompt saw, the SQL that actually ran (post-repair,
  so the `sql` binding at that point in the route), and the same `narrationRows` slice narration is
  about to get — post-guards, post-`applyMoneyUnits`, capped at `NARRATION_ROW_CAP`. Rows go inside the
  existing `NARRATION_DATA_OPEN`/`CLOSE` markers with the same boundary sentence, for the same reason:
  row text is third-party-controlled post-YNAB-import.
- Output is grammar-constrained via Ollama's `format`, the way `SQL_FORMAT` already constrains SQL
  generation, to `{"reason": string, "verdict": "ok" | "mismatch" | "out-of-scope"}` — `reason` first,
  so the one line is written *before* the label rather than justifying it afterwards.
- It is asked three checkable questions, not "is this right": does every filter in the query correspond
  to something the question asked for; does each column's label describe what its expression computes;
  is the result's shape (one figure versus a breakdown) the shape the question asked for. **A
  `mismatch` whose `reason` names none of the three is downgraded to `ok` by the route** — a verdict
  that cannot say what is wrong is not evidence.
- It is not shown the SQL prompt's worked examples, the knowledge block (ADR-0007 stands unchanged for
  this phase), or any statement that the SQL was generated carefully. The SQL is presented as a claim
  to check, not as context to trust. That framing is the whole difference between a second look and an
  echo, so it is asserted directly in a prompt test, the way
  `tests/chatSqlPromptGuardMatrix.test.ts` asserts what the SQL prompt teaches.

**Model and budget: no new configuration.** The verifier runs on `sqlModel` at `SQL_NUM_CTX`. It reads
SQL, `sqlModel` is already warm from earlier in the same turn, and reusing its `num_ctx` avoids the
~5s runner reload a third distinct context size would cost (measured, `SQL_NUM_CTX`'s comment in
`app/api/chat/route.ts`). On a split `sqlModel`/`narrationModel` config the turn becomes
sql → verify → narrate, which is still exactly one runner switch. No `verifierModel` Settings key in
Phase A; adding one waits until the data says the verifier is the weak link.

`num_predict` is capped small — a line of prose and a label — and the call gets its own **20s timeout**,
expiring to `unusable`. `OLLAMA_TIMEOUT_MS` (120s) is per call, so leaving it alone would put a
three-call turn's worst case near six minutes for an answer that was in hand after two. No per-turn
wall-clock budget is introduced; that is ADR-0012's Phase B work and needs the loop to be worth doing.

## Consequences

**Every answer gets slower, including the correct ones.** One more round-trip on a warm model, bounded
at 20s. Accepted for the same reason ADR-0012 accepted its budget: on a single-user LAN app a wrong
answer costs more than a slow one.

**Phase A's own accuracy becomes measurable before its verdicts are trusted.** Run `scripts/chatEval`'s
fixture questions twice — once with the correct ground-truth SQL, once with deliberately broken SQL —
and read the verifier's precision and recall directly. Phase B's gate should be read off a verifier
whose error rate is known, otherwise the gate inherits an unmeasured instrument. Nobody has run this
yet; it is the first thing to run after the call ships.

**The verifier inherits the generator's blind spots,** as ADR-0013 said. Expect shape and label errors
caught reliably, semantic ones unevenly, and a false-`mismatch` rate that is not zero. The
name-the-specific-failure rule and the fail-open posture both exist to keep that rate from becoming a
usability regression.

**It sees the same 20 rows narration sees, so it cannot catch a truncation error.** A query returning
500 rows is judged on the first 20, exactly as narration is. Widening that is a real question and
deliberately not answered here.

**ADR-0014's reason set holds at four.** No new wire type, no client change: a non-`ok` verdict emits
the `no-answer` frame that already exists, with a route-written message. The model's `reason` string is
captured (ADR-0026) and never shown — a decline the model phrases is a decline the model can talk
itself out of, and that text is written from third-party-controlled rows.
