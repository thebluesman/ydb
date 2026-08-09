# ADR-0028: The verifier is told which filters are mandatory, from a constant shared with the SQL prompt

Status: Accepted
Date: 2026-08-09

## Context

The first production `ChatVerdict` sample (n=18, 2026-08-04 + 2026-08-09) came back 10 `ok` / 8
`mismatch` / 0 `out-of-scope` / 0 `unusable`. Reading all eight mismatch reasons against the SQL that
produced them, **three are false positives on SQL that is correct**, and all three fail the same way:

- *"total spending, excluding transfers, for the last 3 months"* — `Filter: The query excludes
  transfers but does not filter by category or description to exclude non-spending transactions.`
- *"total income last month"* — `Filter: The query filters for positive amounts and excludes
  transfers, which is not explicitly mentioned in the question.`
- *"average amount I spend per grocery transaction"* — `Filter: The query filters for transactions in
  the '🛒 Groceries' category, which may not match what was asked for.`

`buildVerificationSystemPrompt`'s FILTER check reads: *"A filter the query never mentioned … is a
mismatch."* `buildSqlSystemPrompt` **mandates** four predicates on essentially every financial query,
none of which any user ever mentions: `transactionType != 'transfer'` (ADR-0019),
`parentTransactionId IS NULL`, `reimbursementTxId IS NULL`, and `status IN ('committed','reconciled')`.
The two prompts are in direct contradiction. The verifier is correctly applying a rule that condemns
the generator's own mandated output, and it is the single largest identified source of false
`mismatch` — which, since a `mismatch` refuses the turn outright, is a usability regression.

This is a consequence of ADR-0025's deliberate choice not to show the verifier the SQL prompt. That
choice is right and stays: the SQL is a claim to check, not context to trust. But "here is what the
generator was *required* to write" is not the same kind of information as "here is how the generator
was taught to write it" — the first is a closed, fixed set of four predicates decidable from the SQL
text alone, the second is the worked examples whose framing ADR-0025 exists to keep out.

## Decision

**The four mandatory hygiene predicates are exempt from the FILTER check, and the exemption list is a
single exported constant that both `lib/chatSqlPrompt.ts` and `lib/chatVerification.ts` read.**

- The constant is the source of truth for "predicates the question never needs to ask for." Neither
  prompt restates the list in prose. A predicate added to the generator's mandate without being added
  here is a drift bug, so the two cannot silently disagree the way they do today.
- The verifier prompt states the exemption as fact about the query it is reading — these predicates
  are ledger hygiene, present by construction, never evidence of a mismatch — and nothing else about
  how the SQL was produced. No worked examples, no statement that the query was written carefully,
  no sign reasoning (ADR-0025's addendum stands).
- The FILTER check otherwise keeps its current wording. A category, account, date range or grain the
  question did not ask for is still a mismatch; only the closed hygiene set is exempted.
- `tests/chatSqlPromptGuardMatrix.test.ts`'s sibling: a test asserts the constant is referenced by
  both prompt builders, so the exemption cannot be reintroduced as drifting prose in either one.

This does not widen what the verifier is trusted to believe about the *answer*. It removes a
question the verifier was being asked to have an opinion on and could only get wrong.

## Consequences

**Expected precision gain is real but unmeasured, and must be measured before it is claimed.**
`scripts/evalChatVerifier.ts` is re-run before and after; the 0.56 model-alone precision is the
baseline. If precision does not move, the diagnosis above was wrong and this ADR should be revisited
rather than patched with more wording.

**Recall may fall, and that is the accepted risk.** A query that omits a hygiene filter it needed —
the `total income` case in this same sample, missing `reimbursementTxId IS NULL` — is a real defect
the verifier could in principle catch. Exempting the predicate class makes that omission invisible to
the FILTER check. Whether an *absent* mandatory filter should be its own deterministic check
(decidable from the SQL alone, ADR-0016's test, and therefore code rather than prompt) is a separate
decision and is not taken here.

**It does not fix the other five mismatches.** Two are genuine query defects the verifier flagged for
the wrong reason, two are questions that should never have reached SQL generation (ADR-0029), and one
is a taught two-column comparison the verifier misread. This closes one failure class, the largest and
the only one that is a contradiction rather than a model limitation.

**ADR-0025 is not superseded.** Its framing — a second look, not an echo — is the reason this ADR
exempts a closed list of predicates rather than showing the verifier the SQL prompt. The narrow
exception is stated here so the boundary stays legible; ADR-0025 is not edited.
