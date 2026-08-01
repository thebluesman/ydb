# ADR-0016: Guard enforcement splits on what the generated SQL alone can decide

Status: Accepted
Date: 2026-07-31

## Context

PR #32 fixed two live-found bugs in `SQL_SYSTEM_PROMPT`: an income/expense query with no
`transactionType` guard double-counted every transfer leg, and a transfer-volume query used a bare
`SUM(amount)` that cancels to zero by construction. Both fixes were prompt-only.

Auditing the prompt afterwards, the worked examples apply the four money guards inconsistently:

| Example | status | `parentTransactionId IS NULL` | `reimbursementTxId IS NULL` | `transactionType` |
|---|---|---|---|---|
| How many transactions | yes | **no** | n/a | n/a |
| Spend on <category> last month | yes | yes | yes | n/a (no sign branch) |
| Spent on <category> in June | yes | yes | yes | n/a |
| Top 5 spending categories | yes | yes | **no** | yes |
| Total income this month | yes | **no** | **no** | yes |
| Earned and spent last month | yes | yes | **no** | yes |
| Income and expenses this year | yes | yes | **no** | yes |
| Moved between accounts | yes | n/a | n/a | yes (`= 'transfer'`) |
| No-matching-category sentinel | yes | yes | yes | n/a |

The reimbursement guard is present in exactly the three category-filtered examples and absent from
all four sign-branching aggregates — backwards, since the rule's own text calls those "true net
spend". The paired-credit half (`NOT EXISTS (SELECT 1 …)`) appears in zero examples; it exists only
in prose. Split-leg exclusion is present in three aggregates and missing from the income one beside
them. Few-shot shape beats prose instruction — ADR-0008 says so in as many words — so an example
missing a guard is an instruction to omit it.

This is the fourth time this initiative has found a well-formed query returning a confidently wrong
number, and the fourth time it was found by Shyam asking a question rather than by coverage. The open
question the ticket poses is whether ADR-0008/0010/0011's lesson — prompt-only proved insufficient,
enforcement moved into code — applies again here.

## Decision

**Guard enforcement moves into a route-level check only where the guard's applicability is decidable
from the generated SQL alone. Where applicability depends on what the question meant, the guard stays
prompt-only, and the prompt's own examples are held consistent by a test over
`buildSqlSystemPrompt`'s output.**

What ADR-0008, ADR-0010 and ADR-0011 moved into code are all properties of the SQL string: a compound
SELECT always collapses labels, `openingBalance` is always off-limits, an unmatched category literal
always matches nothing. None needs to know the question. Guard *absence* is not a property of the
SQL — it is a relation between the SQL and the question. `reimbursementTxId IS NULL` is required for
"what did I spend" and wrong for "what was I reimbursed"; the two produce identical query shapes.

Two shapes are decidable, and both are the PR #32 bugs stated as SQL properties:

1. A query that branches on the sign of `amount` (`amount > 0`, `amount < 0`, `CASE WHEN amount …`)
   and contains no `transactionType` predicate at all. The prompt's rule already fires
   unconditionally at that trigger. The check demands *some* transactionType predicate, not a
   specific one, so the transfer-volume shape passes.
2. A bare `SUM(amount)` over a `WHERE` that pins `transactionType = 'transfer'`. Approximately zero
   for any ledger, however much moved — arithmetically dead regardless of intent.

Both refuse under ADR-0014's `unsupported-shape`, alongside `compoundSelectViolation`.

Split-leg and reimbursement get no detector. A check for them would have to infer stock-versus-flow-
shaped intent from the question, which is exactly the proxy ADR-0015 spent three mechanisms
discovering the pipeline cannot make. Their protection is instead a guard-matrix test asserting each
worked example carries every guard applicable to its shape. That is expressible in code where a
detector is not, because the prompt is our own deterministic artifact — the test validates what we
teach, not what the model returns.

## Consequences

**Prompt drift stops being invisible.** The matrix is a table in a test, so adding a worked example
without its guards fails CI rather than waiting for a live session. This is the first structural
answer to the "found by live-testing, not coverage" pattern behind ADR-0008/0010/0011.

**The audit itself ships with this ADR.** Missing `reimbursementTxId IS NULL` added to the four
aggregate examples, missing `parentTransactionId IS NULL` added to the income and count examples, and
the paired-credit `NOT EXISTS` demonstrated in exactly one example rather than all — over-guarding
teaches the model to attach it to reimbursement questions, where it is wrong.

**Two detectors are a `@backend-engineer` ticket, not shipped here.** They are code on the chat route
next to `lib/chatCompoundSelect.ts`, and both need refusal copy naming the arithmetic problem.

**The detectors can over-reject, in the same direction as ADR-0011's.** A sign-branching query that
legitimately wants transfers included must say `transactionType IN (…)` explicitly to pass. That is
the accepted trade, and the fix if it bites is a code-computed path, not a carve-out.

**A residual the audit did not close.** The three category-filtered spend examples carry no
transactionType guard, correctly under the rule's stated trigger, but a transfer leg carrying a spend
category would be counted. Whether such rows exist is a ledger question for `@qa`; logged as an open
question in `docs/architecture.md`, not guessed at here.

**Invariants untouched.** Integer-cents money, `lib/accounts.ts` sign rules and the read-only guard
(`lib/prisma.ts`) are unchanged. These are scope checks on generated SQL, not safety checks.

**`@qa`:** the PR #32 questions stay regression cases. Added: a sign-branching query with no
transactionType predicate is refused, and `SUM(amount)` over transfer-pinned rows is refused, while
the transfer-volume few-shot itself still passes both.

## Addendum (2026-08-01): "some transactionType predicate" means a comparison, not a mention

Reviewing PR #35 — this ADR's own deferred detectors — `@backend-engineer` flagged that the
implementation is stricter than § Decision reads literally. § Decision says the check "demands *some*
transactionType predicate, not a specific one". The shipped detector accepts only an actual comparison
(`=`, `==`, `!=`, `<>`, `IN`, `NOT IN`); a bare `GROUP BY transactionType`, a bare
`SELECT transactionType`, and `transactionType IS NOT NULL` do not satisfy it.

**The stricter reading is the correct one and stands.** "Not a specific one" was written to mean *not a
specific transaction type* — the sentence's own stated purpose is "so the transfer-volume shape passes",
i.e. so that `= 'transfer'` satisfies the check as readily as `!= 'transfer'`. It was never about the
syntactic form. § Consequences already says so in the other direction: "a sign-branching query that
legitimately wants transfers included must say `transactionType IN (…)` explicitly to pass" — naming a
comparison, not a mention.

The looser reading is also self-defeating, which settles it independently of authorial intent. `GROUP BY
transactionType` and `IS NOT NULL` both leave every transfer leg inside the aggregate; the outgoing leg
is still counted as spending and the incoming leg still as income. A check those forms satisfy would
pass exactly the queries this detector exists to refuse, while reporting itself as enforced. That is
worse than no detector, because it converts a known gap into an assumed cover.

Same shape as ADR-0011's addendum, and recorded for the same reason: the decision is unchanged, only
its stated extent was loose, because it was written from the failure that had been seen rather than
from the arithmetic underneath it. A future implementer reading § Decision alone could reasonably have
built the weaker check, and this addendum is what stops that.

Two related calls in PR #35, confirmed rather than decided here, since both follow from "the figure is
arithmetically dead" rather than from any new judgement: `SUM(-amount)` counts as bare (negating a pair
that sums to zero still sums to zero), while `SUM(ABS(amount))` deliberately does not (doubled, but not
dead); and `amount >= 0` / `<= 0` are sign branches while `= 0` / `!= 0` are not (the zero row is not
what makes the split wrong).

**Known residual, accepted.** The detector looks for a transactionType comparison anywhere in the
statement rather than in the clause governing the sign branch, so a subquery carrying one satisfies it
for an outer bare split. That under-detects rather than over-rejects, needs a real parser to close, and
has not been seen live. Logged here rather than fixed.
