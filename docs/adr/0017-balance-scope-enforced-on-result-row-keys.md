# ADR-0017: Balance scope is also enforced on result-row keys, after execution

Status: Accepted
Date: 2026-08-01

## Context

`@qa`'s ticket-5 fixtures (PR #33) landed a gap as an intentionally-failing tripwire.
`SELECT * FROM Account WHERE accountType = 'auto_loan'` names no column, so both of the text checks
kept as ADR-0015's second net pass it — `OPENING_BALANCE_RE` finds no `openingBalance` in the query
string, and there is no alias to assert anything. SQLite then expands the star, `openingBalance`
arrives in the result rows, and narration is free to read it as the loan's current balance. That is
ADR-0009's miss restated: a check aimed at a construct the model does not have to use.

The column list of a star projection is not knowable from the query string. It is knowable from what
came back.

## Decision

**The balance-scope rules are additionally applied to the keys of the rows a query actually returned,
after execution and before narration.** Same two rules, unchanged — `openingBalance`, then the four
`BALANCE_ALIAS_WORDS` — evaluated against result-row keys rather than against the SQL text
(`balanceScopeRowViolation` in `lib/chatBalanceScope.ts`). A violation returns ADR-0014's
`out-of-scope` non-answer. This is one scope decision with a third enforcement point, not a second
policy: the scope call itself is ADR-0009's, restated by ADR-0010 and ADR-0015, and is untouched here.

**Rejected: banning `SELECT *` in the SQL text.** Cheaper, and it never spends a query, but it moves
enforcement back onto the input — the direction ADR-0010 abandoned for cause after ADR-0009's
input-side check proved to have a 100% miss rate on the only real balance bug in the log. It also
over-rejects into ordinary territory: "show me my recent transactions" is a perfectly good star
projection over a table with no sensitive column, and over-rejection is the failure the fixtures file
exists to catch.

Checking the rows is ADR-0010's own logic followed to its end rather than an extension of it. ADR-0010
moved enforcement to the *output label* because narration receives `JSON.stringify(rows)` and the key
is the only thing telling it what a number means. Result-row keys are those labels — the same labels,
resolved by SQLite instead of written out by the model. The model-written ones were always the weaker
proxy.

**Executing before judging is not a departure from the pre-execution posture, because the posture is
about narration, not the database.** `lib/prisma.ts` is the safety boundary and is untouched; nothing
unsafe runs either way. Every text check still runs first, so a query that names `openingBalance` is
still refused without executing. What this adds is a refusal for a query no text check could have
judged, paid for with one local SQLite read on a connection that already ran it. The expensive and
irreversible half is the narration call, and that is what this stops.

## Consequences

**One guard in the chat pipeline now runs after execution, and it is the only one.** That is a real
architectural asymmetry and it should stay a deliberate exception, justified by the specific fact that
star expansion is resolved by the engine. A second post-execution guard is the signal to reconsider the
phase ordering rather than to add a third.

**It is exact where the text checks are heuristic.** It inspects what the engine produced and never the
query, so it is explicitly not the "general query analysis" ADR-0010 forbids growing this into.

**`lastReconciledBalance` is now refused too**, via the alias-word rule, though nobody asked for it.
Correct and in scope: it is a stored balance, and reporting it as a current one is the same wrong-number
failure by a different column. Reviewed and kept.

**Over-rejection widens slightly, in the accepted direction.** Any query whose result set carries a
balance-worded column is declined, including a `SELECT *` over `Account` asked for entirely innocent
reasons. The prompt is paired against this — a rule discourages star-projecting `Account` — so
prevention and detection sit together the way ADR-0008 pairs them for categories.

**Invariants untouched.** Integer-cents money, `lib/accounts.ts` sign rules and the read-only guard are
unchanged. This is a scope check on a result set, not a safety check.
