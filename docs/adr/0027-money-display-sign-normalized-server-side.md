# ADR-0027: Money display sign is normalized server-side, on the one row binding narration and the `result` frame share

Status: Accepted
Date: 2026-08-04

## Context

Live turn, 2026-08-04. "How much did I spend on groceries last month?" narrated "You spent 3654.43 AED
on groceries last month" while the `result` card directly beneath it read `-3,654.43`. The SQL was
`SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🛒 Groceries' …`.

Three separate things produced that, and only the first was suspected:

1. **Nothing decides display sign.** `lib/chatSqlPrompt.ts:273` teaches an alias convention — an alias
   containing "spent"/"spending" promises the SQL negated the sum, a plain `total`/`net` keeps the raw
   signed value. So whether the user sees `3654.43` or `-3654.43` for the same question depends on
   which alias the model happened to write that turn. That is a prompt-level convention standing in for
   a display rule, the exact arrangement ADR-0008/0010/0011/0016/0017/0018/0020 have each had to
   replace with a deterministic check, and the same one ADR-0025's addendum replaced for the
   *verification* side one day earlier (`signPromiseViolation`, prompt-taught reasoning at 0.43–0.62
   precision → a code check at 1.00/1.00).

2. **Narration's positive phrasing is emergent, not instructed.** `buildNarrationSystemPrompt`
   (`lib/chatKnowledge.ts:236`) states units and says nothing whatsoever about sign. "You spent
   3654.43" from a row reading `-3654.43` is the model doing something sensible unprompted. Nothing
   holds it there, and nothing makes it agree with the table.

3. **The `result` frame does not think that column is money at all.** `buildResultFrame` takes its
   `kind: 'money'` set from `moneyUnitsPlan(sql).convertKeys` — the keys that needed *converting*.
   A `/100.0` projection is classified `already-converted` and never enters that list, and **all nine
   of the SQL prompt's worked examples divide by 100**. Verified by running the real functions: that
   query yields `convertKeys: []`, so the card column is `kind: 'number'` and `ChatResult.tsx` renders
   it through `toLocaleString`, not `fmtMoney` — which is why the tile showed a bare `-3,654.43` with
   no currency at all. ADR-0023's "a key is money exactly when `convertKeys` named it" is false for the
   dominant query shape.

Units already stopped being the model's problem (ADR-0020). Sign is the same class of question with
the same answer available, and it is now the only remaining money property the SQL prompt is trusted
to get right.

## Decision

**Display sign is decided by the server, per money column, from the direction restriction the query
itself already made — and applied once, after verification, to the single row binding that both
narration and the `result` frame consume.**

The load-bearing half is *once, to one binding*. Whatever a column's sign ends up being, the sentence
and the table cannot disagree about it, because they are handed the same numbers.

`lib/chatMoneyUnits.ts` is extended rather than joined by a second module — it already walks the final
`SELECT`'s projection, resolves money columns against the schema, resolves table qualifiers and handles
star expansion, and a second copy of that machinery is how `lib/chatAccountVocabulary.ts`'s resolver bug
would have been reproduced instead of inherited-fixed. Its header stops describing "units" and starts
describing money-column *presentation*. `MoneyUnitsPlan`'s `ok` variant gains two fields beside
`convertKeys`:

- **`moneyKeys`** — every result key whose projection item resolves to exactly one money column,
  converted or not. An item resolves by stripping one top-level `/ 100`/`/ 100.0` divisor and then
  applying the existing `resolveUnitPreservingMoneyColumn`. This, not `convertKeys`, is the set
  `buildResultFrame` uses for `kind: 'money'`. A derived ratio that merely *mentions* `amount` does not
  resolve and stays `number`, which is stricter than today's `containsMoneyColumn` reuse and keeps
  ADR-0020's documented ratio blind spot from leaking a currency symbol onto a non-currency figure.
- **`magnitudeKeys`** (⊆ `moneyKeys`) — keys whose direction is already fixed by the query, so their
  sign carries no information and display shows `|value|`. A key qualifies when **either** the
  projection item negates its money column (`SUM(-amount)`, `-amount`, a `CASE` whose value branches
  are all `-amount` or numeric literals) **or** the statement's top-level `WHERE` pins that column's
  direction (`amount < 0`, `<= 0`, `> 0`, `>= 0`, qualifier-resolved the same way the star rule
  resolves one).

A new `applyMoneySign(rows, plan)` mirrors `applyMoneyUnits`: `Math.abs` on `magnitudeKeys`, numbers
only, `NULL` and absent values pass through untouched.

**Everything else stays signed, by default and without an exception.** A bare `SUM(amount) AS net` with
no direction filter keeps its sign — that is the deferred case where the sign is the answer, and it
needs no special handling because it never enters `magnitudeKeys` in the first place. A mixed
transaction list (`SELECT date, description, amount …`, or a star over `Transaction`) keeps its signs
too: there the sign is direction, not an artifact, and a list where a salary and a grocery run both read
positive is a worse bug than the one being fixed. This is why the rule is not "every money column shows
magnitude" — that version breaks a shape that ships today.

**Pipeline position: after `verifyResult`, before `buildResultFrame`** (`app/api/chat/route.ts`, between
the verdict branch at ~816 and the frame build at ~828). Hoist one `const plan = moneyUnitsPlan(sql)` at
the existing `applyMoneyUnits` call (~719) and reuse it; `displayRows = applyMoneySign(narrationRows,
plan)` feeds both `buildResultFrame({ rows: displayRows, … })` and the narration prompt body (~904).
`hedgeGrounds` and `suggestionsFrame` keep the pre-display binding — they read count columns and SQL
text, not money signs.

Units convert early and sign normalizes late, and the asymmetry is the point: **a unit is a property of
the stored column, so converting it early makes every downstream consumer correct; a sign here is a
presentation choice, so it must come after every consumer that reasons about the query's own
arithmetic.** ADR-0016's detectors, `signPromiseViolation` (ADR-0025 addendum) and the Phase A verifier
all judge what the SQL computed; hand any of them a sign the server invented and they are grading the
server's arithmetic rather than the model's.

**One sentence is added to the narration system prompt**, beside the units sentence: a monetary value's
sign has already been normalized for display, an outflow figure arrives as a positive magnitude, and the
narrator states direction from the question and the column name rather than by adding or removing a minus
sign. Point 2 above is why — leaving the prose side to emergent good behaviour after fixing the table
side deterministically would just move the disagreement.

**This fails open to signed, never refuses.** ADR-0020 fails closed because an unresolved unit
manufactures a 100x error under a prompt that no longer hedges; an unresolved *direction* costs a minus
sign in front of a correct number. Refusing a turn over that would be wildly out of proportion. A
`SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS total` — sign pinned inside a `CASE` value branch
rather than in `WHERE` — is a known under-detection that lands on today's behaviour, not a wrong one.

## Consequences

**The alias sign-promise convention stops being the display mechanism.** It stays in the prompt for
now, because `signPromiseViolation` reads it and that check measures 1.00/1.00, but its remaining job is
as a proxy for a mis-scoped aggregate, not as what the user sees. Whether to delete both together is a
separate decision and is left open in `docs/architecture.md`, not settled here.

**`SUM(-amount) AS total_spent` and `SUM(amount) AS total` over the same `amount < 0` filter now display
identically.** That is the same convergence property ADR-0020 relied on for converted and unconverted
projections, and it is what removes the turn-to-turn variance Shyam actually hit.

**Every `/100` aggregate becomes a `money` column in the frame, which is user-visible.** Those cards and
table cells move from `toLocaleString` to `fmtMoney`, so they gain the currency the frame has been
carrying and not showing. This changes ADR-0023's stated `money`-membership rule; that rule was written
as a reuse of ADR-0020's classifier and is corrected here rather than superseded, since the intent — the
route decides what is money, exactly once — is unchanged.

**A future signed-answer type is not foreclosed.** `magnitudeKeys` is opt-in from an explicit trigger, so
a net-savings or cash-flow answer is signed by default with nothing to unwind, and if it ever needs a
rule of its own the place to add it is one function. Deliberately not designed now.

**A third post-execution stage.** ADR-0017 asked that the post-execution phase not grow casually and
ADR-0020 already treated that trigger as fired for ADR-0012's loop design. This one is not a judgement at
all — it is a pure formatting transform on values, decided pre-execution off the SQL like ADR-0020's, and
it should land inside the `run_sql` tool's return shaping under Phase B rather than as another route step.

**Integer-cents storage, `lib/accounts.ts` and the read-only guard are untouched.** Like ADR-0020 this
operates on the serialized copy handed to presentation; it is a display rule, not a safety or a
correctness one.
