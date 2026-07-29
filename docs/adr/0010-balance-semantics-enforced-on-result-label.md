# ADR-0010: Balance semantics are out of scope for chat SQL, enforced on the result label

Status: Accepted
Date: 2026-07-29
Supersedes: ADR-0009

## Context

ADR-0009 was written from narration output alone. `ChatMessage.sql` persists every generated query, so
the 2026-07-29 session is recoverable. Reading it back changes the diagnosis.

The query behind the `AED -49,818.75` / `AED 50,989.23` contradiction (session 11) joins no `Account`,
references no `openingBalance`, and involves no sign convention. It is a `UNION ALL` of an expense sum
and an income sum. SQLite names a compound result set after its first branch, so both rows reach
narration as `{"total_expenses": ...}` and the income label is destroyed. The "near mirror images"
reading was wrong: those are one month's outflow and inflow for someone roughly breaking even. That
defect is a result-labeling failure and ADR-0011 handles it.

The real balance bug is in the same testing session. Session 10, "which should I pay off first",
generated `SELECT Account.name, SUM("Transaction".amount) / 100.0 AS total_balance ... WHERE
strftime('%Y-%m', date) = strftime('%Y-%m', date('now'))`, and narration reported "a car loan with a
total balance of AED 2344.68". That is one month's net flow on a liability account, labeled and served
as the debt owed. The canonical figure is `openingBalance − Σ amount` over the account's whole life
(`computeBalance`). The query never touches `openingBalance`.

That is the finding that matters. **ADR-0009's enforcement — reject generated SQL naming
`openingBalance` — would not have caught the only real balance bug in the log.** All ten accounts
currently have `openingBalance = 0` (ADR-0003), so the model has no reason to select that column and
every reason to pass a bare `SUM(amount)` off as a balance. The check was aimed at the one construct
the model does not use.

## Decision

**Balance, net worth, and amount-outstanding stay out of scope for chat-generated SQL — ADR-0009's
scope call stands. The enforcement moves from the input column to the output label.**

`SQL_SYSTEM_PROMPT` states that `SUM(amount)` over an account is net flow across the filtered period
and is never a balance, that balances and net worth are not derivable in SQL, and that
`Account.openingBalance` is not to be selected or aggregated. The route rejects generated SQL naming
`openingBalance`, and additionally rejects SQL whose result-column aliases assert balance semantics
(`balance`, `net_worth`, `outstanding`, `owed`), returning the same legible out-of-scope response.

Policing the alias follows from what narration can see. It receives `JSON.stringify(rows)` and nothing
else — no schema, no SQL, no account types. The column name is the only thing telling it what a number
means, and it is written by the model at inference time. `total_balance` is not a description of the
query, it is an unverified claim about the query, and in session 10 it was false. Rejecting the claim
is cheaper and more honest than checking the arithmetic behind it.

The rest of ADR-0009 carries over: the check lives in `app/api/chat/route.ts` and not in
`lib/prisma.ts`, a scope rejection short-circuits rather than feeding the repair round-trip,
transaction-level aggregates stay fully in scope, and a `computeBalance`-backed path feeding narration
as data is still the named long-term answer.

## Consequences

**ADR-0009's ticket must not ship as written.** The scope decision was right, the mechanism was not.
`@backend-engineer` implements this ADR instead.

**The check is still a heuristic, and now an honest one.** It fires on the model's own labeling, so a
balance aliased `total` slips through. That is a real gap, bounded by the fact that narration has to
name the figure to mislead. It is strictly better than a check with a demonstrated 100% miss rate on
the observed bug. Do not grow it into general query analysis; needing exceptions is the signal to build
the `computeBalance` path.

**Over-rejection is wider than ADR-0009's.** "Balance" is an ordinary word, so a legitimate per-account
flow question the model happens to alias `balance` gets declined too. Same safe direction as before, at
a somewhat higher rate.

**`openingBalance` stays banned though it is zero everywhere today.** ADR-0003's zeros are an accident
of the migration and correctness should never have rested on them. Keeping both checks costs one line.

**No invariant changes.** Integer-cents money, the `lib/accounts.ts` sign rules, and the read-only
guard (`AGENTS.md` § Canonical decisions) are untouched. ADR-0007 narration is unaffected.

**`@qa` gets a concrete regression fixture.** Session 10's query is the case to assert on: a
liability-account `SUM(amount)` aliased as a balance must be declined, and the transaction-level
aggregates in sessions 6 and 9 must still pass.
