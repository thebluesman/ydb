# ADR-0032: Calendar boundaries are computed server-side and handed to the model as literals

Status: Accepted
Date: 2026-08-19

## Context

`lib/chatSqlPrompt.ts` has now done the same thing three times, and re-argued it in a comment block
each time. Each was written in response to a live wrong answer, not to a hypothetical:

- **Bare month name.** Observed 2026-07-29: "What was spent on Travel in June?" needs a literal
  `'YYYY-MM'`, and the model had nothing to derive the year from except its own sense of the present.
  It resolved June to `'2023-06'`, which matched nothing. `mostRecentMonthYm` now computes it.
- **Quarters.** SQLite has no `start of quarter` modifier. The model's two remaining options are
  `strftime('%m')` arithmetic it gets wrong under load, or a boundary recalled from training data —
  the month bug one granularity up. `quarterOf`/`shiftQuarters`/`quarterRange` now compute it.
- **Calendar weeks.** Observed 2026-08-09: "What transactions were on my salary account this week?"
  generated `date >= date('now','-7 days')` — a trailing window, not the calendar week. Both SQLite
  idioms for the real boundary are unsafe: `date('now','weekday 0','-7 days')` slides a whole week
  into the past on the one day of the week it lands on, because `weekday N` is a NO-OP when the date
  is already that weekday; and `strftime('%W', ...)` puts the days before the year's first Monday in
  week 00, so "last week" by subtracting 1 breaks every January. `weekRange` now computes it.

Three instances is where a pattern stops being a coincidence. The reasoning is identical each time and
is currently discoverable only by reading three comment blocks, so a fourth granularity — day-of-week
naming, fiscal year, a pay period — starts by re-deriving the argument or, worse, doesn't.

Worth naming precisely what these three failures have in common, because it is not "the model is bad
at dates". It is that all three produce **well-formed SQL over the wrong dates**. There is no error,
no empty result to notice, no arithmetic tell. The answer is precisely bounded and confidently wrong,
which is the same failure shape ADR-0011 and ADR-0019 were written for.

## Decision

**Any calendar boundary the chat SQL prompt needs is computed in TypeScript from `now` and
interpolated into the prompt as a literal, whenever SQLite has no modifier for that boundary or the
available modifier has a known edge case. The model is never asked to do calendar arithmetic and never
asked to recall what the date is.**

Concretely, for a new granularity:

1. If a plain `date('now', ...)` modifier resolves it correctly at execution time — "last month",
   "this year", "the last 30 days" — leave it to SQLite. Those stay relative on purpose; substituting
   a literal there makes a query that was correct whenever it ran correct only on the day it was
   generated.
2. Otherwise write a pure function of `now` in `lib/chatSqlPrompt.ts` — UTC, half-open
   (`>= start AND < endExclusive`), exported, unit-tested against the year boundary and the on-the-
   boundary day — and interpolate its output into the prompt as a literal, with a worked example
   using it.
3. State in the prompt which idiom the model must *not* reinvent, and why. The rules name
   `date('now','-7 days')`, `date('now','weekday 0','-7 days')` and `strftime('%W', date)` explicitly,
   because a prohibition the model can't recognise itself about to violate does nothing.

Two boundaries the model may derive itself, and only these, both anchored to a literal the server
already supplied: prose deriving one from another (*"'Last quarter' is the three months before
`<thisQ.start>`"*), and a shift of a whole number of days off a supplied date
(`date('<thisWeek.start>','-14 days')`). Day arithmetic is exact — it has no NO-OP case, and it
carries across month, year and leap-day boundaries — but only because the anchor is a literal. A
Monday the model worked out itself is not an anchor.

Where a boundary must be computed **per row** rather than per request, a literal is not available, so
the server authors the *expression* instead and the prompt tells the model to copy it verbatim.
`weekStartExpr()` (added 2026-08-19 for weekly bucketing) is the first of these. It is the same
decision, one level up: the exact string is authored once, in code, verified against a real SQLite
engine, rather than reconstructed per query by a model with no way to notice it got it wrong.

## Consequences

**The prompt grows with each granularity, and that is the cost.** Every rule added under this
decision is more tokens in a prompt that already competes for context, and one more literal that has
to be right. The trade is deliberate: the alternative is a class of wrong answer with no tell.

**A boundary is only correct for the request that rendered it.** These literals are per-request, which
is why `buildSqlSystemPrompt` is a function of `now` rather than a constant, and why both SQL passes
in a turn (first attempt and repair) are handed the same string. A cached prompt would be a stale
calendar; nothing currently caches it, and nothing should without revisiting this.

**Verification against real SQLite is part of the decision, not a nicety.** Two idioms that "should"
have worked did not — that is the entire evidence base here — so a new expression under rule (3) or a
per-row expression is checked against an actual engine before it ships. `weekStartExpr` was verified
over 1,501 consecutive days; `tests/chatSqlPrompt.test.ts` keeps that check rather than asserting the
string.

**This does not make the model's date handling correct, only its date *boundaries*.** Choosing the
wrong granularity is a separate failure the prompt addresses separately and imperfectly: "the last 7
days" versus "this week" is a reading of the question, not a boundary computation, and the rule
distinguishing them is prose the model can still misread. Nothing here catches that.

**Questions anchored to something the ledger does not record stay declined.** "The week before my
paycheck hits" has no stored anchor, so there is no boundary to compute and the prompt refuses to
invent one. This decision is about boundaries that exist and are computable, not about widening what
the ledger knows.

**No invariant changes and no new mechanism.** These are pure functions of `now` feeding a string;
integer-cents money, `lib/accounts.ts` sign rules and the read-only guard (`lib/prisma.ts`) are
untouched. This ADR records a pattern that already shipped three times prompt-only, so that a fourth
has a precedent to cite instead of a comment block to re-derive.
