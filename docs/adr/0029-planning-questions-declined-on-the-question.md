# ADR-0029: Planning, forecast and goal questions are declined on the question, like balance questions

Status: Accepted
Date: 2026-08-09

## Context

Two of the eighteen production `ChatVerdict` rows are questions this ledger cannot answer at all:

- *"What should I budget for next month?"* → generated a sum of last month's spend aliased
  `last_month`, verdict `mismatch` with reason `Label: The column label 'last_month' does not clearly
  describe the computed value as total income.` (The reason is also wrong about what the column holds.)
- *"Am I on track to hit my savings goal?"* → generated a two-column CASE aggregate filtered on
  `category = 'YNAB'`, verdict `mismatch` with reason `Filter: The query filters transactions by
  category 'YNAB', which is not mentioned in the question.`

Neither is a badly-written query for an answerable question. YDB stores a transaction ledger. It has
no budget targets, no savings goals, and no forecasting model — there is no rewrite of the SQL that
answers either one. The correct verdict for both is `out-of-scope`, and the verifier emitted
`mismatch` for both; across all 18 turns it emitted `out-of-scope` **zero** times, so that label is
currently unused in production and cannot be relied on to catch this class.

The second case is the one that matters. `category = 'YNAB'` is a genuine stored value — on exactly
one transaction — so ADR-0008's vocabulary grounding passed it, and the query returned a real,
plausible-looking number purporting to describe savings progress. That is ADR-0015's failure mode
repeated in a new scope class: a flow figure dressed as an answer to a question about something the
ledger does not model. ADR-0015 settled that the fix for that shape is to refuse on the question,
before any SQL is generated, because the question is the one input that is not model output and the
intent is stated plainly in it.

## Decision

**Extend ADR-0015's question-level scope check with a second class: questions asking what to do next
rather than what happened.** The route returns ADR-0014's `out-of-scope` non-answer before the SQL
call, exactly as it does for stock nouns.

The vocabulary is words that can only denote a forward-looking plan, target or prediction:
*budget for / should I budget*, *savings goal / goal*, *on track*, *afford / can I afford*,
*forecast*, *predict*, *projected*, *how much should I*, *will I have*. As with ADR-0015 it matches
the current question only, never prior turns.

Two boundaries are deliberate:

- **Past-tense spending on a planning word stays answerable.** "How much did I spend on my savings
  transfers last month" is a flow question and must not be caught; the match is on the planning sense
  (a target, a projection, an ought), not on the noun wherever it appears — same discipline ADR-0015
  applied to *payoff* the noun versus *pay off* the verb.
- **This is a scope decline, not a "not built yet" decline.** The `out-of-scope` message names what
  the ledger holds — recorded transactions, not budgets or goals — rather than implying the feature
  is coming. ADR-0013 Phase C's `get_balances` would close the *balance* class; nothing on the roadmap
  closes this one, because closing it means storing budget targets, which is a product decision nobody
  has made.

## Consequences

**Two of eighteen turns (11% of the sample) stop producing a wrong number.** Refusing is the whole
value here; the latency saved is incidental.

**Over-rejection is the accepted cost, in the same direction as ADR-0015.** A legitimate historical
question phrased with a planning word will be declined. A decline that names what it declined is a
better outcome than a savings-progress figure computed from a one-row junk category.

**It removes two data points from `ChatVerdict`, and that is correct.** They are turns where a
route-level guard should have fired; keeping them in the verdict table as `mismatch` inflates the
verifier's apparent recall with cases it got right by accident and for a wrong stated reason.
ADR-0026's separation of "a guard refused" from "a model guessed" is the reason this matters.

**It does not address why `category = 'YNAB'` was selectable.** ADR-0008's grounding is a membership
test over stored values, not a relevance test, so a category on one transaction is as eligible as one
on four hundred. That is a real and separate gap, recorded as an open question rather than decided
here — this ADR only stops the one question class that made it visible.

**`@qa` gets a fixture pair,** matching the ADR-0015 set: both questions above must be declined with
the Ollama SQL call asserted never to happen, and a past-tense question containing a planning word
must still generate SQL.
