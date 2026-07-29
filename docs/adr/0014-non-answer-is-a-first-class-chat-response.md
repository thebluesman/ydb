# ADR-0014: A non-answer is a first-class chat response, not an error

Status: Accepted
Date: 2026-07-29

## Context

Shyam's feedback names "says I don't know rather than confidently returning something wrong" as a
distinct want, separate from the architecture that produces the answer. It is worth deciding on its
own, because the current pipeline has no representation for it at all and one can be built today.

Right now chat has exactly two outcomes. It streams a confident narration, or it returns an HTTP error
— 503 for an unreachable Ollama, 422 for a non-`SELECT`, a SQLite failure, or an ADR-0010/0011
rejection. There is no third thing. So an honest "I can't answer that" has to borrow the crash
pathway and reads to the user as a broken app rather than a careful one.

Worse, the most common non-answer never reaches the error path at all. A query that runs cleanly and
returns nothing produces `[{"total": null}]`, which narration renders as a confident zero. "You spent
nothing on groceries last month" is not a non-answer; it is a wrong answer that happens to be caused by
missing data. ADR-0008's unmatched category literal fails exactly this way.

## Decision

**The chat stream gains a `no-answer` response type, distinct from both narration and error, carrying a
machine-readable reason and the SQL that was attempted.** Declining is a normal outcome of a working
system; only transport and unexpected faults stay HTTP errors.

Four reasons, which are the four ways the pipeline can honestly fail to answer:

- **`out-of-scope`** — the question is not answerable from the ledger, or is declined by policy
  (balance and net worth, ADR-0010). Ideally declared before a query runs.
- **`no-data`** — the query ran and returned nothing, or an aggregate over zero rows. Explicitly *not*
  narrated as zero. The distinction between "your total is 0" and "I found no matching transactions" is
  the single most valuable thing in this ADR and the cheapest to implement.
- **`unsupported-shape`** — the result cannot be trusted to mean what it claims: ADR-0010's balance
  aliases, ADR-0011's `UNION` rejection, ADR-0013's verifier returning a non-`ok` verdict.
- **`budget-exhausted`** — reserved for ADR-0012's loop. The iteration or row budget ran out before the
  model reached an answer it would stand behind. Surfaced as "I ran N queries and couldn't get to a
  confident answer", with the queries shown.

Two rules govern all four:

1. **A non-answer shows its work.** The attempted SQL goes to the client, same as the existing
   `type: 'sql'` frame. `ChatMessage.sql` is what made ADR-0010's diagnosis possible after ADR-0009
   misdiagnosed the same bug from narration output alone; a non-answer is exactly when that matters.
2. **Exhaustion is a signal, not a prompt instruction.** `budget-exhausted` in particular is decided by
   the route counting iterations, not by asking the model to notice it is stuck. A model confident
   enough to be wrong is confident enough to claim it is done.

## Consequences

**Shippable before any of ADR-0012's architecture.** Three of the four reasons exist in today's
pipeline and are currently mis-rendered as errors or as confident zeroes. This can land alongside
ADR-0013's Phase A, and `no-data` can land before even that.

**A non-answer must say what it tried, not just that it failed.** "I couldn't answer that" is barely
better than a 422. "I looked for transactions in a `Groceries` category last month and found none —
your categories are: …" is a real answer to a different question, and often the more useful one. Same
standard ADR-0010 and ADR-0011 already set for their rejection messages.

**The honest-failure rate becomes visible, and will look bad at first.** Failures that used to render
as plausible sentences will start rendering as declines. That is the point — it is the same number
either way, and the current presentation is the dishonest one — but expect the first week to feel like
a regression.

**Some questions will move from wrong to unanswered rather than to answered.** This ADR buys trust, not
capability. Capability is ADR-0013's Phase C.
