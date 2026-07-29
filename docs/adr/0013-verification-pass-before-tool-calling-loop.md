# ADR-0013: Phase A of the agentic chat work is a verification pass, not a tool-calling loop

Status: Accepted
Date: 2026-07-29

## Context

ADR-0012 sets the target architecture. Shyam asked for this built over time, not as one rewrite. The
question is what ships first.

Tool-calling is technically available today (measured: `qwen2.5:32b` advertises `tools`, emits
well-formed `tool_calls` in ~7s). So "wait for capability" is not the reason to phase. The reason is
that a loop is a large change to the one route that sits on the read-only guard, and there is **no eval
harness** for the chat path — the standing gap already blocking ADR-0006's revisit and ADR-0007's
retrieval layer. Rebuilding the route into a loop with no way to measure whether it got better would
be replacing a known-flawed pipeline with an unmeasured one.

There is a smaller step that fits today's non-loop setup and produces the missing measurement.

## Decision

**Phase A is a verification pass: one extra non-streaming model call between execution and narration
that reviews the result against the question and returns a structured verdict. Narration is gated on
it.** Phases B and C follow, each gated on evidence from the one before.

- **Phase A — verification pass.** Inputs: the question, the generated SQL, and the result rows.
  Output: a small structured verdict (answers the question / wrong shape or label / no usable data /
  out of scope) plus a one-line reason. A non-`ok` verdict routes to ADR-0014's non-answer instead of
  narration. Fits the current architecture exactly — one more `/api/generate` call, no tool-calling, no
  change to the guard, no change to ADR-0007's injection sites. Adds one round-trip of latency.
  Crucially, it also **produces the eval data**: every verdict is a labeled sample of how often this
  pipeline is wrong and how, which is the harness nobody has scoped.

- **Phase B — single-tool loop.** Move to `/api/chat` with `run_sql` as the only tool, under ADR-0012's
  budgets. The win here is the model getting to *look before it commits* — `SELECT DISTINCT category`
  before filtering on a guessed literal. ADR-0007 gets superseded here, not earlier. Gated on Phase A
  verdict data showing which failure classes actually dominate.

- **Phase C — code-computed tools.** Add tools backed by real code rather than generated SQL:
  `get_balances` over `computeBalance`, `list_accounts`, `list_categories`. This is what finally closes
  the standing "no code-computed balance path for chat" open question and lets ADR-0010's blanket
  decline become a real answer. Gated on Phase B being stable in daily use.

Phase A is unblocked now. B and C are dormant, in the ADR-0002 sense: named, sequenced, not started.

## Consequences

**Visible improvement without touching the guard.** Phase A converts the most common failure — a
confident answer over data that does not support it — into an honest non-answer, and ships as an
additive call. The single highest-value single check in it is trivial: `SUM` over zero rows returns
`null`, not `0`, and today narration turns `[{"total": null}]` into "you spent nothing".

**The verifier is the same local model, so it inherits the same blind spots.** It will not catch what
the generator could not see. It is a second look, not an oracle. Expect it to catch shape and
emptiness problems reliably and semantic ones unevenly.

**Honest feasibility read — where ADR-0006 bites hardest.** Not SQL syntax, which the local models
handle. It is **root-cause self-correction inside the loop**. Probed directly on 2026-07-29: given back
a `null` result for "how much did I spend on groceries last month", `qwen2.5:32b` did notice the
failure and did retry — but it retried by *adding a date filter*, not by questioning the `'groceries'`
literal that actually caused the null. It narrowed the wrong axis. That is precisely the correction a
loop exists to make, and the local 32B did not make it unaided.

The consequence is a design rule for Phases B and C: **the loop's value is that the model gets to look,
not that the model figures it out.** Tools must be shaped so that looking is cheap and the obvious next
step is the right one. That is why Phase C's code-computed tools matter more than loop depth, and why
raising the iteration cap is not the lever it looks like.

**What is genuinely not reachable locally.** Open-ended multi-hop financial reasoning at Claude/GPT-4
fluency — "am I on track", "what should I do differently" — is not coming from a 32B on this box, and
no amount of phasing gets there. Shyam should go in expecting chat to land at *reliable, checkable, and
willing to admit ignorance* rather than *brilliant*. Given that he currently trusts the ledger over
chat, trust is the actual product; eloquence is not the gap.

**One untried local lever, named rather than taken.** `qwen3.6:latest` is already installed and reports
`thinking` alongside `tools`, with a 262k context. A thinking model is materially better at loop
control than a non-thinking one, and it is free to try. It is not adopted here because there is nothing
to measure it with — which is Phase A's other output, and the reason Phase A comes first.
