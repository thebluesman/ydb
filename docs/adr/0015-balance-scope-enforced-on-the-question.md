# ADR-0015: Balance scope is enforced on the question, before SQL is generated

Status: Accepted
Date: 2026-07-30
Supersedes: ADR-0010

## Context

Shyam live-tested PR #30 (ADR-0010's alias check) and asked "What's the balance on my car loan?". The
model generated a bare net-flow sum aliased `net`:

```sql
SELECT SUM(amount) / 100.0 AS net FROM "Transaction" WHERE category = '🚗 Auto loans' AND ...
```

Narration answered "The balance on your car loan is AED 7034.04." That is session 10's bug verbatim —
net flow served as the debt owed — reached without anyone trying to dodge anything. `net` is the
obvious name for a `SUM(amount)`.

ADR-0010 anticipated a miss here and called it a bounded gap ("a balance aliased `total` slips
through"). It is worse than that: the ADR's premise is false. It reasoned that "narration receives
`JSON.stringify(rows)` and nothing else … the column name is the only thing telling it what a number
means." Narration also receives the user's question — it must, to answer conversationally. In this
failure the alias contributed nothing. Narration said "balance" because Shyam asked for a balance.

That relocates the defect. The alias check polices whether the *SQL* labels a figure honestly. The
harm is narration asserting balance semantics in prose. Those are different layers, and the question
is the input that drives the second one. Any check downstream of generation is guessing at intent that
was stated plainly in the question. And widening the alias vocabulary cannot work: the complement of a
four-word blocklist is unbounded (`net`, `flow`, `sum`, `delta`, `movement`), and ADR-0010 itself bans
growing the check into general query analysis.

## Decision

**Scope stays as ADR-0009 and ADR-0010 set it — balance, net worth and amount-outstanding are not
answerable by chat-generated SQL. Enforcement moves upstream again, to the user's question, and fires
before any SQL is generated.**

The route classifies the question text for stock-not-flow intent and returns ADR-0014's
`out-of-scope` non-answer immediately, with no Ollama call on the SQL path. The vocabulary is nouns
and phrases that can only denote a stock: *balance*, *net worth*, *owe / owed / owing*, *outstanding*,
*debt*, *principal*, *payoff*, *how much is left on*, *how much do I have in*. It matches the current
question only, never prior turns.

ADR-0010's two post-generation checks stay exactly as PR #30 implements them —
`openingBalance` and the four balance-asserting aliases. They are now a second net rather than the
mechanism: they catch the model reaching for balance arithmetic on a question that named no stock
noun ("how much is on my car loan"), which the question check misses.

Enforcing on the question is sound where the alias check is a proxy. The user's wording is the one
input that is not model output, it is available before a token is spent, and it is the actual cause of
the misframing. Refusing "what's my balance" is correct under a scope decision that is now three ADRs
old; the only thing this changes is *when* the refusal happens, which ADR-0007 already logged as an
open question ("refusal happens after the query runs").

## Consequences

**PR #30 does not merge as-is.** It is not wrong, it is insufficient. `@backend-engineer` adds the
question check on the same branch. The alias check and its tests survive unchanged.

**Over-rejection moves and grows.** "How much did I pay off my car loan last month" is a legitimate
flow question containing *pay off*, so `payoff` must match the noun, not the verb phrase — and some
legitimate questions will still be declined. That is the same safe direction ADR-0009 and ADR-0010
chose, now paid earlier and more visibly, and a decline that names what it declined and points at the
dashboard (ADR-0014's standard) is a far better outcome than AED 7034.04 asserted as a debt.

**A narration-prompt rule was considered and declined.** Telling narration "never call a figure a
balance" is another instruction on the same model that already ignored `SQL_SYSTEM_PROMPT`'s "`SUM(amount)`
is never a balance" — and if it worked, the result is narration echoing 7034.04 with the framing filed
off, which is a wrong answer with better manners. If a question is a balance question, the answer is
a refusal, not a hedge. ADR-0007's narration prompt is untouched.

**This is the third mechanism for one scope decision, and that is the finding.** ADR-0009 checked the
input column, ADR-0010 the output label, this one the question. Each was falsified by a live session
the previous one could not see. The pipeline has no representation of stock-versus-flow anywhere, so
every check is a proxy for a distinction the system cannot make. The question check is the last cheap
proxy available; if it also needs an exception, the answer is not a fourth heuristic but the
`computeBalance`-backed path (ADR-0013 Phase C, `get_balances`). That path's priority goes up on the
strength of this session.

**No invariant changes.** Integer-cents money, `lib/accounts.ts` sign rules, and the read-only guard
(`lib/prisma.ts`) are untouched; the check reads a string and decides whether to proceed.

**`@qa` gets a second fixture.** The PR #30 regression set stays. Added: this session's question must
be declined before `generateSql` is called (assert the Ollama SQL call never happens), and flow
questions naming an account or category must still pass.
