# ADR-0011: Chat SQL returns each metric as its own column; UNION is rejected

Status: Accepted
Date: 2026-07-29

## Context

Asked "If I lose my job, how long could I cover expenses?" on 2026-07-29 (session 11), the chat
narrated two contradictory figures, `AED -49,818.75` and `AED 50,989.23`, and hedged that "the negative
value might indicate some kind of credit or income". The persisted `ChatMessage.sql` shows why. The
model produced a `UNION ALL` of two aggregates, aliased `total_expenses` and `total_income`.

SQLite names a compound result set after its first branch only. Re-running the query returns:

```json
[ { "total_expenses": -49818.75 }, { "total_expenses": 50989.23 } ]
```

That JSON is exactly what narration is handed. The income row arrives labeled as expenses. Narration
then did the right thing under ADR-0007 — it spoke only from its rows and declined to conclude — but
its rows were mislabeled before it saw them, so the best available behaviour was still a
self-contradicting answer about money.

Nothing upstream catches this. The SQL is valid, the read-only guard passes it, execution succeeds, and
there is no error for the repair round-trip to act on. It is the ADR-0008 failure shape again: a
well-formed query producing a confidently wrong answer, invisible to everything except a human who
already knows the numbers.

The label collapse is also undetectable downstream. The duplicate key is gone by the time the route
holds row objects, so nothing on the narration side can recover the second branch's alias.

## Decision

**Chat-generated SQL may not use `UNION` or `UNION ALL`. A question asking for several metrics is
answered with several aliased columns in one row.** `SQL_SYSTEM_PROMPT` states the rule and carries a
few-shot example of the correct shape (`SELECT SUM(CASE ...) AS total_expenses, SUM(CASE ...) AS
total_income FROM "Transaction" WHERE ...`), and the route rejects generated SQL containing a compound
`UNION`, short-circuiting rather than feeding the repair path.

A flat ban is defensible because this schema has one fact table. Every multi-metric question here is
expressible as conditional aggregates in a single row, which is both the clearer query and the one that
preserves labels. `UNION` buys nothing and is precisely the construct that discards them.

Rejecting outright rather than repairing keeps the failure legible. The repair round-trip exists for
SQLite errors and there is no error here; re-prompting on a valid query would just re-roll the dice.

## Consequences

**A construct the model reaches for gets declined until the prompt rule takes hold.** The prompt change
is the fix and the route check is the backstop, so the expected steady state is few rejections. If they
stay common, the few-shot is not landing and that is the thing to change, not the check.

**The check is textual and can over-reject.** A question whose text contains the word "union" is not
affected — the check reads generated SQL, not the question — but a legitimate `UNION` would be declined
if one ever became necessary. If that happens, the fix is a code-computed path, not a carve-out.

**The rejection message must name the shape problem.** "I couldn't build a single clear result for
that — try asking for one figure at a time" is useful. A bare 422 is not, same standard as ADR-0010.

**This closes the mislabeling channel, not the labeling-is-a-claim problem.** ADR-0010 covers the other
half: an alias that asserts a semantic the arithmetic does not deliver. Both come from the same root —
narration sees `JSON.stringify(rows)` and the column name is the only carrier of meaning — and both are
enforced on generated SQL in `app/api/chat/route.ts`.

**Invariants untouched.** No change to `lib/prisma.ts`, `lib/accounts.ts`, or money representation. The
read-only guard stays input-agnostic and single-purpose; this is a scope check, not a safety check.

**Implementation is a separate ticket for `@backend-engineer`.** `@qa` should assert the session 11
question no longer yields two identically-named columns, using the persisted query as the fixture.

## Addendum (2026-07-30): the ban covers all three compound operators

Reviewing PR #31 before merge, `@backend-engineer` pointed out that this ADR's text names `UNION` and
`UNION ALL`, and the implementation scoped detection to those two accordingly — leaving SQLite's other
two compound operators, `INTERSECT` and `EXCEPT`, undetected. They have the identical defect. The
first-branch naming rule is a property of compound SELECTs in SQLite, not of `UNION`: `SELECT a AS x …
EXCEPT SELECT b AS y …` returns its rows keyed `x`, exactly as `UNION` does. The failure this ADR
exists to prevent is therefore still reachable, by a keyword nobody has yet seen the model produce.

**Decided: widen the ban to all three. Chat-generated SQL may not use `UNION`, `UNION ALL`,
`INTERSECT` or `EXCEPT`.** The decision is unchanged; only its stated extent was too narrow, because it
was written from the one operator that had misfired in front of a human rather than from the SQLite
rule underneath it.

Closing this pre-emptively rather than waiting for a live sighting is the deliberate call, and it is a
narrower rule than it looks. Nothing new is being judged: the ban is already flat, the justification
already rests on the schema having one fact table, and neither `INTERSECT` nor `EXCEPT` has a
legitimate use against a single fact table any more than `UNION` does — so the over-rejection risk this
ADR accepted does not grow. What changes is three keywords in one regex.

The general discipline of reacting to confirmed failures over speculated ones still holds, and this is
not a licence to pre-empt hypotheticals. It is set aside here on two specifics. The failure class is
silent and money-denominated: it produces a confident, well-formed, wrong figure that only a reader who
already knows the number can catch, so "wait for it live" means "wait until it has already been
believed". And the mechanism is a known, documented SQLite rule rather than a guess about model
behaviour — the uncertainty is only over *when* the model reaches for the keyword, never over what
happens if it does. PR #29 and PR #30 each shipped an ADR whose scope a live session then widened; a
third instance, when the widening was identified in review and costs a regex change, would be a choice.

`@backend-engineer` applies this to the same branch before merge, in `COMPOUND_RE` in
`lib/chatCompoundSelect.ts` — the constant already documents itself as the place a widening lands. The
refusal message and the `SQL_SYSTEM_PROMPT` rule name the operator they saw, so both need to speak of
compound SELECTs generally rather than of `UNION` specifically. `@qa`: the session 11 fixture stays the
regression case, plus one synthetic `EXCEPT` and one `INTERSECT` query asserting the same refusal, and
an identifier such as `except_flag` or a literal containing the word asserting no false positive.
