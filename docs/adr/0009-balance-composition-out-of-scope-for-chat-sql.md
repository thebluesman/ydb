# ADR-0009: Balance composition is out of scope for chat-generated SQL

Status: Superseded by ADR-0010
Date: 2026-07-29

> Superseded 2026-07-29, same day. The scope call here was right; the Context misdiagnosed the repro
> and the enforcement mechanism followed the misdiagnosis. The cited query never referenced
> `openingBalance`. See ADR-0010. Kept unedited below as the record of what was decided.

## Context

Same testing session as ADR-0008. Asked "If I lose my job, how long could I cover expenses?", the
assistant narrated two conflicting totals from one result set: `AED -49,818.75` and `AED 50,989.23`.
Near mirror images, which is the signature of asset-style and liability-style sums added together
without normalising signs.

`app/api/chat/route.ts` does not import `lib/accounts.ts`. It has no notion of `computeBalance`,
`isAsset`, or `isLiability`. `SQL_SYSTEM_PROMPT` exposes `Account(..., openingBalance, accountType,
...)` as bare columns and says nothing about the arithmetic that turns them into a balance. The
canonical rule is that a liability balance is `openingBalance − Σ amount` and an asset balance is
`openingBalance + Σ amount`. Every other consumer in the app branches on `isLiability` correctly. The
chat path is the only one that doesn't, and it is the only one where the arithmetic is written by a
language model at inference time.

This is the exact invariant `AGENTS.md` names canonical and `docs/architecture.md` lists as
do-not-break. Raw transaction-level sums are not the risk surface — `SUM(amount) WHERE
transactionType = 'debit'` is sign-consistent regardless of account type. The risk is specifically
anything that composes `openingBalance`, or that combines per-account sums across mixed account
types: balances, net worth, runway, "how much do I have".

ADR-0003 currently masks part of it. YNAB-imported accounts are recreated with `openingBalance: 0`,
so today the openingBalance term is often zero and the damage comes from the sum side alone. That is
an accident of the migration, not a property to rely on.

## Decision

**Chat does not answer balance-composition questions. `SQL_SYSTEM_PROMPT` states that
`Account.openingBalance` is not to be selected or aggregated and that account balances and net worth
are not derivable in SQL, and the route rejects generated SQL that references `openingBalance`,
returning a clear out-of-scope response.**

The rejected alternative was teaching the prompt the sign rule. It fails on principle and on
evidence. On principle, `lib/accounts.ts` is single-source-of-truth by design; restating its
arithmetic in a prompt creates a second copy that drifts, in the one place where correctness cannot
be verified by reading the code. On evidence, a temperature-0 model already produced a
self-contradicting result set here, and there is no harness to demonstrate a prompt rule fixed it.
Refusing a question is a correct answer. A confidently wrong money figure is the failure this app's
invariants exist to prevent.

The rejection lives in `app/api/chat/route.ts`, not in `lib/prisma.ts`. The read-only guard stays
input-agnostic and single-purpose (`docs/architecture.md` § Chat pipeline); this is a scope check on
generated SQL, not a safety check, and merging the two would blur a boundary that is currently clean.
A scope rejection must also short-circuit rather than feed the repair round-trip — the repair path
exists for SQLite errors, and letting it retry here just buys a second attempt at the same
out-of-scope query.

Transaction-level aggregates stay fully in scope and are untouched. The intended shape of the answer
to "how long could I cover expenses" is a monthly spend rate from transactions, plus a balance the
user reads off the dashboard.

**Restoring these questions requires a code-computed path that calls `computeBalance` and feeds the
result to narration as data.** That is the right long-term answer and it is named here as the
follow-up, not scoped or committed.

## Consequences

**A category of question chat used to attempt now gets declined.** Those attempts were producing
wrong numbers, so this is a strict improvement in correctness and a visible reduction in capability.
Shyam is the only user and the dashboard already answers these, so the workaround is one click.

**The refusal must be legible.** "I can't compute account balances yet — check the dashboard" is
useful; a bare 422 is not. The out-of-scope message is part of the deliverable, not a fallback.

**A textual check on generated SQL is approximate.** It catches `openingBalance` by name, which is the
only route to a balance in this schema, but it is a heuristic and it can over-reject — a question that
merely mentions an opening balance in passing will be declined too. Over-rejection is the safe
direction here. Do not extend the check into general query analysis; if it starts needing exceptions,
that is the signal to build the `computeBalance`-backed path instead.

**The `openingBalance: 0` accident (ADR-0003) is no longer load-bearing.** Correctness stops depending
on the migration's choice of opening balances, which is what it should never have depended on.

**No change to `lib/prisma.ts`, `lib/accounts.ts`, or the money representation.** Integer cents, the
sign rules, and the read-only guard (`AGENTS.md` § Canonical decisions) are all preserved; this ADR
exists to stop the chat path from quietly working around the second of them. Narration and knowledge
injection (ADR-0007) are unaffected — the block is background vocabulary and never asserts figures
the rows don't support, which is why this bug surfaced as bad SQL rather than bad narration.

**Implementation is a separate ticket for `@backend-engineer`**; no code here. `@qa` should verify
that transaction-level sums still pass and that a mixed-account-type balance question is declined
rather than answered.
