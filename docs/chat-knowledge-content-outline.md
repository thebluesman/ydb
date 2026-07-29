# Chat knowledge — content outline

Owned by `@product-manager`. Deliverable for chat-knowledge ticket 1. This is the **topic list only** —
no content is written here. Ticket 2 drafts the snippets against this outline, ticket 3 decides where
they live, ticket 4 wires them into `app/api/chat/route.ts`.

## Location context (addendum, 2026-07-29)

Shyam is UAE-based. The outline is meant to be location-agnostic and most of it is — sections A, C
and F hold anywhere. But a few snippets inherit US assumptions from the source material they were
surveyed from, and would read as subtly wrong here. Where that's true, the affected rows carry a
**UAE note** below.

Two structural differences drive all of it:

- **No personal income tax.** "Take-home pay" and gross-vs-net framing collapse to roughly the same
  number, so any snippet leaning on that distinction loses its point.
- **No public safety net for expats.** No unemployment insurance backstop, and visa status is tied to
  employment — losing a job starts a clock, not just an income gap.

Ticket 2 should write these as location-aware rather than UAE-only: state the general principle, then
name the factor that moves it. That keeps the snippets portable if Shyam ever moves.

## Why this exists

YDB's chat is a two-phase pipeline today: text-to-SQL over the ledger schema, then a narration pass
over the returned rows. Both system prompts are hardcoded strings in `app/api/chat/route.ts`, and
neither carries any notion of good financial practice. Ask it "how much did I spend on food last
month" and it answers well. Ask it "is that a lot" or "should I pay the card down first" and it has
nothing to reason from.

The gap this initiative closes is the second kind of question. The answers should come from a small
curated body of financial-hygiene knowledge injected into the prompt — not retrieved from an index,
since there is no vector store and building one for a single-user LAN app is not warranted.

## Constraints the snippets have to respect

These bound what ticket 2 can write, so they're recorded here rather than discovered later.

- **One idea per snippet.** Each row in the tables below should become one atomic snippet, short
  enough that several can be injected without crowding out the ledger rows in the narration prompt.
- **Ledger data wins.** A snippet is a lens for interpreting the query result, never a substitute for
  it. Nothing in the knowledge body should let the model answer a factual question about Shyam's money
  without querying.
- **Injection target is the narration phase.** The SQL-generation prompt is schema-and-dialect
  instruction at temperature 0; adding financial philosophy there risks worse SQL for no benefit.
  Ticket 4 should assume narration-side injection unless `@tech-lead` says otherwise.
- **No regulated-advice territory.** See the flagged list at the bottom. YDB is a ledger with a chat
  interface, not an advisor.
- **Envelope-compatible.** Shyam's working mental model is YNAB's. A snippet that quietly assumes a
  different model (e.g. percentage-of-income allocation as the default) will read as wrong even when
  it's defensible in the abstract.

## A. Envelope-budgeting foundation

Highest priority as a group: this is the model Shyam already runs on, so these snippets set the
default frame everything else is expressed in.

| # | Topic | What the snippet says | Priority |
|---|---|---|---|
| A1 | Give every dollar a job | Money is allocated to a purpose on arrival; unassigned cash is a decision deferred, not a surplus | P0 |
| A2 | Budget the money you have | Allocate from the current balance, not from projected income — the source of envelope budgeting's stability | P0 |
| A3 | Roll with the punches | Overspending a category is a re-plan (move money between envelopes), not a failure to be tracked as guilt | P0 |
| A4 | True expenses / sinking funds | Annual and irregular bills get monthly allocations so they never arrive as shocks | P0 |
| A5 | Age of money / buffer | Spending money that arrived a while ago is the goal state; a one-month buffer is the practical target | P1 |

## B. Budgeting frameworks

Covered so the assistant can talk about alternatives without treating them as interchangeable.

| # | Topic | What the snippet says | Priority |
|---|---|---|---|
| B1 | Zero-based budgeting | Every unit of income assigned until nothing is unallocated; how it relates to A1 | P1 |
| B2 | 50/30/20 | Needs/wants/savings split as a coarse sanity check, not an allocation mechanism. **UAE note:** the rule is stated against post-tax take-home in its US framing; with no personal income tax the gross/net gap is negligible, so ticket 2 should say "income you actually receive" and skip the take-home explainer | P1 |
| B3 | Where each framework breaks | Irregular income breaks percentage rules; high fixed-cost ratios make 50/30/20 read as failure when nothing is wrong | P1 |

## C. Cash-flow hygiene

The recurring-spend traps. These are the snippets most likely to be triggered by an actual query
result, so they carry a lot of the practical value.

| # | Topic | What the snippet says | Priority |
|---|---|---|---|
| C1 | Fixed vs variable vs discretionary | The three-way split, and why only one of them responds to willpower | P0 |
| C2 | Subscription creep | Small recurring charges compound invisibly; annualize before judging, audit on a cadence | P0 |
| C3 | Small-ticket drift | Dining out, delivery, convenience purchases — individually trivial, collectively a top-three category | P0 |
| C4 | Lifestyle inflation | Spending rising to meet income increases; the counter-move is allocating the raise before it lands | P1 |
| C5 | Irregular income smoothing | Budget from a trailing conservative baseline, hold the overage as buffer rather than re-baselining upward | P1 |
| C6 | One-off vs trend | A single spike is not a pattern; how many periods it takes before a category change means something | P1 |

## D. Debt

**UAE note (applies to the whole section).** As surveyed, this section assumes a US-card-centric
picture where consumer debt means revolving credit-card balances. UAE consumer borrowing leans more
on fixed-term personal loans for big-ticket items, often with flat-rate interest quoted up front and
early-settlement fees, alongside cards. Ticket 2 should write D1–D3 so instalment debt is a
first-class case rather than an afterthought, and so a snippet triggered by a loan-shaped liability
in the ledger doesn't narrate it as if it were a card.

| # | Topic | What the snippet says | Priority |
|---|---|---|---|
| D1 | Avalanche vs snowball | Highest-rate-first minimizes interest, smallest-balance-first sustains motivation; the tradeoff is arithmetic vs adherence. **UAE note:** both orderings assume the payoff order is the borrower's to choose. Fixed-term loans mostly aren't accelerable without a settlement fee, so ticket 2 should scope the ordering advice to the debts that are actually flexible | P0 |
| D2 | Debt vs saving priority | The interest-rate heuristic for ordering paydown against savings, and why a starter emergency fund usually comes first regardless. **UAE note:** the "emergency fund first" side of this gets stronger here, not weaker — see E1 | P0 |
| D3 | Revolving-interest mechanics | Statement balance vs minimum payment, how carried balances accrue, why paying in full is a different behaviour from paying on time. **UAE note:** this one is genuinely card-specific. Ticket 2 must either label it as such in the snippet text, or pair it with a companion note on flat-rate/reducing-balance instalment interest so the model doesn't apply revolving mechanics to a personal loan. Recommend the label — a second snippet is cheaper to cut under prompt budget | P0 |
| D4 | Debt as negative cash flow | Framing minimum payments as a fixed cost that shrinks the budget's usable surface | P2 |

## E. Reserves

| # | Topic | What the snippet says | Priority |
|---|---|---|---|
| E1 | Emergency fund sizing | The months-of-expenses heuristic and what moves the number (income stability, dependants, fixed-cost ratio). **UAE note:** the standard 3–6 months carries an implicit assumption of a public backstop that doesn't exist for an expat here — no unemployment insurance, and residency tied to employment, so a job loss puts relocation costs and a hard deadline on the same balance. Ticket 2 should add those to the list of factors that move the number, and treat the low end of any range as a floor rather than a target | P0 |
| E2 | Where to hold it | Liquidity and separation from daily spending are the properties that matter — stated generically, no products or institutions | P1 |
| E3 | When to draw on it | What counts as an emergency, and that replenishment is the next budget's first job | P1 |

Priorities in this section stay as written, but if ticket 4's prompt budget forces cuts, E2 and E3
should survive ahead of the B and F P1 rows. Reserves do more work in a no-safety-net context than
framework comparison or review cadence do.

## F. Review habits

Practice rather than theory. Lower priority individually, but these are what make the rest stick.

| # | Topic | What the snippet says | Priority |
|---|---|---|---|
| F1 | Reconciliation cadence | Checking ledger against reality on a regular rhythm is what keeps every other number trustworthy | P1 |
| F2 | Category hygiene | Too many categories collapse into noise, too few hide the thing you're looking for; naming consistency matters more than granularity | P2 |
| F3 | Reading a month honestly | Comparing against a trailing average rather than the previous month alone; accounting for period length and timing artifacts | P2 |

## Flagged, deliberately not outlined

Per the ticket's out-of-scope rule, these came up during the survey and are being flagged rather than
written. Each would push chat toward regulated-sounding advice, and none of them can be grounded in
the ledger data YDB actually holds.

- Investment allocation, asset selection, retirement-account strategy.
- Tax planning, deduction strategy, filing questions.
- Insurance coverage adequacy.
- Named products, institutions, or rates.
- Credit-score optimization tactics.
- Debt settlement, consolidation, or bankruptcy.
- Islamic finance and interest terminology. Sharia-compliant structures (murabaha, ijara, profit
  rates rather than interest) are common in the UAE, and whether a given product is compliant is a
  religious-and-regulatory judgement, not a budgeting one. The boundary snippet should cover it:
  chat can talk about what a payment costs in cash terms from the ledger, and declines to rule on
  permissibility or to recommend compliant alternatives. Ticket 2 should also keep the general debt
  snippets from asserting that interest is the only way borrowing is priced.

Recommendation for ticket 2: rather than silently omitting these, write **one** boundary snippet
stating that chat answers questions about the ledger and general budgeting practice and declines the
above. That gives the model an explicit refusal path instead of leaving it to improvise.

## Counts and sequencing

21 content snippets plus one boundary snippet. Suggested ticket 2 sequencing:

1. P0 set (13 snippets) — A1–A4, C1–C3, D1–D3, E1, plus the boundary snippet. This alone is enough
   for ticket 4 to wire up and evaluate.
2. P1 set (A5, B1–B3, C4–C6, E2, E3, F1).
3. P2 set (D4, F2, F3) — write only if the injected prompt still has room after ticket 4 measures the
   real token cost.

That ordering exists because ticket 4 will almost certainly hit a prompt-budget ceiling. Knowing
which snippets are load-bearing before that conversation happens is cheaper than trimming under
pressure.

## Handoffs

- **Ticket 2** takes this table set as its work list. Open question for whoever picks it up: target
  snippet length. It's a direct input to ticket 4's prompt budget, so pick a number and record it.
- **Ticket 3** should note that the count is small and static — 20-odd short files or one structured
  document, not a corpus needing an index.
- **Ticket 4** needs `@tech-lead` sign-off: it touches the chat path guarded by the read-only SQL
  invariant in `docs/architecture.md`. The narration-side injection recommendation above is a
  proposal, not a decision.
