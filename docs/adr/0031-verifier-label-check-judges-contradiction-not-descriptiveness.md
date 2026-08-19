# ADR-0031: The verifier's LABEL check judges contradiction, not descriptiveness

Status: Accepted
Date: 2026-08-18

## Context

`scripts/evalChatVerifier.ts` re-run against live Ollama (qwen2.5:32b), 2026-08-18: combined
TP=10 FP=7 TN=12 FN=1 — recall 0.91, precision 0.59 (model alone 0.56). Every one of the seven false
positives is on a GOOD case, and five of them fail the same way — the LABEL check condemning a
correct, prompt-compliant alias for not being *self-documenting enough*:

- `good:rent-last-month` — *"Label: The label 'total' does not clearly indicate it is a rent expense."*
- `good:rent-total-spent-taught-form` — *"Label: The label 'total_spent' does not accurately describe
  the rent expense."*
- `good:total-expenses-last-month`, `good:account-filtered-category` — *"Label: The label 'total' does
  not indicate that the value is negative."*
- `good:average-grocery-transaction` — *"Label: The label 'total' does not accurately describe the
  computed average amount."*

`buildSqlSystemPrompt` teaches the opposite of what the verifier is demanding. A generic `total` is the
taught alias for a filtered sum — the category, account and period live in the `WHERE` clause, not in
the column name — and `total_spent` is taught only as a sign promise, not as a description of the
category. ADR-0027 went further: the alias stopped being the display-sign mechanism entirely, and the
one sign rule that still matters is checked in code (`signPromiseViolation`, 1.00/1.00) before the
verifier ever runs. So the two "does not indicate that the value is negative" flags are asking the
alias to carry information the server deliberately took away from it.

`buildVerificationSystemPrompt` already forbids the sign reasoning — *"Never flag a column for being
negative, or for being positive, on its own"* — and the model routed around it by complaining that the
*name* fails to encode the sign rather than that the number is negative. That is the same failure mode
ADR-0028 diagnosed on the FILTER check, in a second place: **a negative instruction ("do not judge X")
does not generalize to X's adjacent phrasings; a positive statement of the convention does.** ADR-0028
stated a fact about the query the verifier was reading and removed the question. This does the same
thing for the alias.

The `good:average-grocery-transaction` case is not in this class and is treated separately below —
`AVG(amount) AS total` genuinely mislabels an average as a total, and the verifier catching it is the
check working.

## Decision

**The verifier's LABEL check is stated as a contradiction test, not a descriptiveness test, and the
alias convention is stated to it as fact.**

The LABEL question becomes: does any column's name claim something its expression does *not* compute?
A name that is merely generic, or that omits the filters the query applied, is not a mismatch — the
verifier is told plainly that this codebase's SQL names a filtered aggregate `total`, `net` or
`total_spent` and carries category, account and period in the `WHERE` clause, so a generic alias is the
expected output and never on its own evidence of a problem. The mismatch bar stays where ADR-0025 put
it: `total_expenses` over `amount > 0` is still a mismatch, because the name asserts something false.

The existing anti-sign clause is replaced rather than added to. Instead of forbidding a sign judgment,
the prompt states ADR-0027's fact: display sign is decided by the server after this check runs, the
alias is not the sign channel, and a column's name is not expected to encode direction. A prohibition
the model can rephrase past is not a guard.

The wording is a single sentence-level edit inside `buildVerificationSystemPrompt`. No worked examples,
no category or account vocabulary, no statement that the SQL was written carefully — ADR-0025's "a
claim to check, not context to trust" stands, and this stays inside ADR-0028's already-drawn boundary
between *what the generator was required to produce* and *how it was taught to produce it*.

**Sequencing: this ships together with ADR-0028's still-unimplemented exemption constant, in one
verifier-prompt change, measured once.** ADR-0028 is Accepted but was never implemented —
`buildVerificationSystemPrompt` contains no hygiene exemption and no shared constant exists. Landing a
second prompt ADR on top of an unimplemented first one would make the next eval unattributable.

## Consequences

**Precision gain is expected but unmeasured, and must be measured before it is claimed.** The 0.56
model-alone precision from 2026-08-18 is the baseline; four of the seven false positives are in the
class this addresses. If precision does not move, the diagnosis is wrong and this ADR is revisited
rather than patched with more wording — ADR-0028's rule, applied to ADR-0028's own successor.

**Recall may fall, and that is the accepted risk.** Telling the verifier a generic alias is fine
removes its ability to flag a name that is under-specified *and* wrong — the single FN in this run
(`broken:dining-unrequested-account-filter`, a `total` hiding an unrequested account narrowing) is
adjacent to that. It is a FILTER break, and the FILTER check is where it should be caught, so the
answer if it persists is a deterministic check, not a looser LABEL rule.

**The alias convention now has three consumers**: the SQL prompt teaches it, `signPromiseViolation`
enforces its one hard rule, and the verifier is told it. ADR-0027 left open whether the convention
survives at all; a third consumer raises the cost of retiring it, and that open question moves to
`docs/architecture.md` rather than being settled here.

**It does not fix the other three false positives.** One is a FILTER-check over-reach on a whole-year
window (`good:rent-this-year`), and two are eval-fixture defects, not verifier defects — both are
recorded as scoped follow-ups, not folded into this decision.

## Measured, 2026-08-19 — Accepted

Implemented together with ADR-0028's exemption constant, in one `buildVerificationSystemPrompt` edit, per
this ADR's own sequencing clause. Re-ran `scripts/evalChatVerifier.ts` once against the same fixture set,
live Ollama (qwen2.5:32b):

- Combined: 0.59/0.91 → **0.65/1.00** (TP=11 FP=6 TN=13 FN=0)
- Model only: 0.56/0.90 → **0.63/1.00** (TP=10 FP=6 TN=13 FN=0)
- Precheck (`signPromiseViolation`): 1.00/1.00, unchanged

Precision moved, clearing this ADR's own falsification bar. The accepted recall risk did not materialize
— recall rose rather than fell, and the single prior FN (`broken:dining-unrequested-account-filter`) is
now caught on FILTER, exactly where the Consequences section above said a persisting break belonged.

Four of the five LABEL false positives named in Context are gone. `good:account-filtered-category` still
draws a sign-framing LABEL complaint post-fix — treated as a residual model-limitation instance, not a
prompt contradiction (the diagnosis held; this is one surviving case, not a sign the wording failed). A
scoped follow-up ticket tracks it rather than a further prompt edit, per this ADR's own reasoning against
wording that accretes.

Caveat, stated plainly rather than glossed: this is n=30, one run, against a nondeterministic local
model. Directionally-confirmed, not a settled number — a future eval showing regression is information to
act on, not a reason to have withheld acceptance now.

Reviewed independently by `@tech-lead` (PR #65): rendered `buildSqlSystemPrompt` diffed byte-identical
against `main` across all three vocabulary branches, confirming the SQL-generation prompt was untouched;
full suite (1198/1198), `tsc`, and lint independently re-run clean in a separate worktree.
