# ADR-0019: The transfer-exclusion guard triggers on the aggregate, not on the sign branch

Status: Accepted
Date: 2026-08-01

## Context

ADR-0016 § Consequences left one residual open: its three category-filtered worked examples carry no
`transactionType` guard, correctly under the rule's stated trigger ("this applies whenever the query
filters or branches on the sign of amount"), but a transfer leg carrying a spend category would be
counted. Whether such rows exist was logged as a ledger question in `docs/architecture.md`.

Measured against `prisma/dev.db`, 2026-08-01. Every one of the 44 `transactionType = 'transfer'` rows
carries a nonempty category; 5 of them carry a real spend category — 3 `🚗 Auto loans`, 2
`💰 Personal loans` — and the rest are `Uncategorized`. The category sits on the outgoing leg only
(id=521, `-234468`, `🚗 Auto loans`, linked to id=522, `+234468`, `Uncategorized`). So the answer is
yes, and the categories in question are loan repayments, assigned upstream by the SMS-capture/YNAB
pipeline rather than by any rule this repo controls.

Two things sharpen the finding. First, the shipped prompt is not currently producing a wrong number:
`exampleCategory()` renders `Groceries` and `Travel`, and neither ever appears on a transfer row. The
literal few-shots are safe; the *shape* they teach is not, for any category value that happens to
coincide with one the pipeline assigns to a transfer. Second, one-sided categorisation makes this
worse than the classic transfer double-count, not milder: the counterpart leg is `Uncategorized`, so
nothing cancels. `SUM(amount)` filtered to `🚗 Auto loans` returns the full repayment volume as
spending, and the app's own rule — "transfers are NEITHER income NOR spending", `lib/chatSqlPrompt.ts`
— is violated with no arithmetic tell.

## Decision

**The transfer-exclusion guard's trigger is any spending, income, earnings or net-flow aggregate,
whether or not it branches on the sign of `amount`. A category-filtered spend aggregate needs
`AND transactionType != 'transfer'` for the same reason a sign-branching one does.**

The sign branch was never the reason the guard is required; it was the symptom present in the PR #32
bugs that produced the rule. What makes a transfer wrong to include is that it is not spending — the
sign split is one way to reach it, a category filter is another.

The mirror case is now real and gets stated in the prompt: when the question is *about* a category the
ledger assigns to transfers ("how much did I pay on my car loan"), those rows are the subject and the
guard is wrong. Which categories those are is not fixed and not this repo's to fix — it is whatever
the upstream pipeline assigns.

**This stays prompt-only. No detector.** The mirror case is exactly the question-dependence ADR-0016
made the split on: "how much did I spend on Auto loans" and "how much did I pay on my car loan"
generate the same SQL and want different answers. ADR-0016's criterion is unchanged and this decision
sits inside it — only the prompt rule's trigger widens, and the guard-matrix test's applicability
column widens with it.

## Consequences

**Three worked examples change, and the guard matrix changes with them.** The two category-filtered
spend examples and the no-match sentinel example gain `AND transactionType != 'transfer'`; the matrix
row for a category-filtered spend aggregate moves from `n/a` to required. That is a
`@backend-engineer` ticket alongside the prompt edit, not shipped here — same split as ADR-0016's own
detectors.

**Accepted cost: loan-repayment questions can now be under-answered.** The guard the model is taught
to attach by default is the wrong one for the mirror case, and the only thing pulling it back off is
prose. That is the ADR-0016 trade taken again knowingly: over-excluding returns a defensible smaller
number, under-excluding returns a confident wrong larger one. The real fix is a code-computed path
(ADR-0013 Phase C), not a fourth heuristic.

**Not an addendum to ADR-0016, deliberately.** The earlier addendum clarified an extent that was
loosely stated while the shipped code was already correct. Here the shipped artefact is what changes,
and the widening carries a trade-off of its own. ADR-0016 stands unedited and unsuperseded; it
explicitly deferred this to data, and this is the data arriving.

**`@qa`:** a category-filtered spend query over a category that also appears on a transfer leg
(`🚗 Auto loans` today) must not count the transfer rows — a regression case that would have been
unwritable before the measurement. Its mirror ("how much did I pay on my car loan") is the
counter-case, and is expected to be prompt-only and therefore fragile.

**Invariants untouched.** Integer-cents money, `lib/accounts.ts` sign rules and the read-only guard
(`lib/prisma.ts`) are unchanged.
