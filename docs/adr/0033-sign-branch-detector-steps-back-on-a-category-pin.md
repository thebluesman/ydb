# ADR-0033: The sign-branch detector steps back when the WHERE pins a specific category

Status: Accepted
Date: 2026-10-21

## Context

The eval case `car-loan-payment-transfer-mirror-case` ("How much did I pay on my car loan last month?")
was refused on two 2026-08-19 runs by `signBranchGuardViolation` (ADR-0016's detector 1). The payment
is a transfer whose outgoing leg carries the `Auto Loan Payment` category (ADR-0019's measured shape).
The correct SQL leaves out `transactionType != 'transfer'`, as ADR-0019's mirror-case rule says to, and
it selects that leg by sign, the way the model writes every category total
(`WHERE category = '…' AND amount < 0`). On the fixture ledger that query returns the right $500. The
detector sees a sign branch with no `transactionType` comparison and refuses it.

So two accepted decisions meet on one shape. ADR-0016 refuses any sign branch without a
`transactionType` comparison because that shape is decidable: no question wants transfer legs counted
as income and spending. ADR-0019 says a category-pinned aggregate's transfer guard is *not* decidable.
"What did I spend on auto loans" and "what did I pay on my car loan" produce the same SQL and want
different rows, so ADR-0019 kept it prompt-only. ADR-0016's decidability argument was written about an
unscoped sign split. It does not carry over once a category pin has narrowed the rows to the subject of
the question, and the detector was enforcing it there by accident.

## Decision

**When the WHERE clause pins `category` to specific values, `signBranchGuardViolation` does not fire.
For that shape, transfer exclusion is enforced by the prompt only, under ADR-0019's mirror-case rule.**
This uses ADR-0016's own criterion. It does not change it.

"Pins" is narrow, and any doubt leaves the detector firing (ADR-0016's over-rejecting direction):

- a positive `category = '<literal>'` (or `==`) or `category IN ('<literal>', …)`, in the first WHERE
  clause, at paren depth zero relative to it (a subquery's filter does not count);
- no `OR` anywhere in that clause;
- no pinned value equal to `Uncategorized`. That is where ordinary transfer pairs live, so pinning it
  brings back PR #32's double-count, and no mirror-case question is about it;
- balanced quoting, because literal values are read by offset.

`!=`, `<>`, `NOT IN` and `LIKE` are not pins. An account pin (`a.name = '…'`) is not one either. "What
did I spend from Main Checking" with `amount < 0` would count every outgoing transfer, and nothing
about an account filter suggests the transfers are the subject. The detector's message, the
transfer-sum detector (ADR-0016 detector 2) and the guard-matrix test are unchanged.

## Consequences

**The mirror case can be answered.** Its natural SQL passes the guard chain and returns $500 on the
fixture. The same query with the category pin removed is still refused. Both are unit-tested, with
every near-miss listed above as a still-refused case.

**Accepted cost: a category-pinned sign split now relies on the prompt alone for transfer exclusion.**
"How much did I spend on 🚗 Auto loans" written as `category = '🚗 Auto loans' AND amount < 0`, with no
guard, counts the loan transfer as spending. That is the residual ADR-0019 already accepted for the same
query without the sign branch. This ADR makes the two consistent instead of opening a new gap: before
it, adding `amount < 0` to that query got it refused and leaving it off let it through, which no
principle explains. The fix, if this bites, is ADR-0013 Phase C's code-computed path.

**A narrowing, not a supersession.** ADR-0016 and ADR-0019 both stay Accepted. Same relationship as
ADR-0022 to ADR-0021.

**`lib/chatSqlPrompt.ts` is untouched.** The prompt already states the mirror case. Only the detector
was out of step with it.

**`@qa`:** the eval case's remaining fragility is the model's, not the guard's. A 2026-10-21 run
produced a different wrong query for it (kept the transfer guard and added an `a.name = 'Car Loan'`
filter, giving no-data). That is the prompt-only fragility ADR-0019 predicted, and it is out of scope
here.

**Invariants untouched.** Integer-cents money, `lib/accounts.ts` sign rules and the read-only guard
(`lib/prisma.ts`) are unchanged.
