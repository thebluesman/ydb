# Chat knowledge — snippet content

Owned by `@product-manager`. Deliverable for chat-knowledge ticket 2, written against
`docs/chat-knowledge-content-outline.md` (ticket 1).

> **Superseded for snippet text (ticket 3, 2026-07-29).** The snippets now live one-per-file in
> `docs/knowledge/`, which is canonical and is what the chat pipeline reads. **Edit snippet text there,
> not here.** The bodies below are kept as the frozen ticket-2 record so this file's reasoning stays
> readable on its own; if they ever disagree with `docs/knowledge/`, `docs/knowledge/` wins. The parts
> of this file that remain live are the length decision, the UAE corrections, and the ticket-4 handoff.
> See `docs/knowledge/README.md` for the naming and front-matter convention.

**Count correction (ticket 3).** This file was written describing "22 snippets, 13 P0". The actual set
is **25 snippets: 12 P0, 10 P1, 3 P2**. The P1 and P2 lists were right; the P0 list (A1–A4, C1–C3,
D1–D3, E1, X1) has always been 12 rows, and the total was undercounted. Word totals are unaffected —
~737 words for P0, still the ~950–1,000 tokens the budget was set against. `docs/knowledge/` carries the
corrected figures.

Snippet IDs match the outline's row IDs exactly, so the two documents can be diffed against each
other. Section order follows the outline. Within each section, snippets are listed in outline order,
not priority order — the priority column is repeated on each entry so ticket 4 can filter.

## Target snippet length — decision

**40–70 words, 2–4 sentences. Hard ceiling 80 words. Target average ~55.**

This deliberately tightens the ticket's stated "on the order of 100–200 words per snippet". Reasoning,
recorded because it is a direct input to ticket 4's prompt budget:

- The ticket's 100–200 figure assumed the injection pattern would be "1–2 snippets at a time". The
  outline landed somewhere else: there is no retrieval layer and no index, so the realistic ticket 4
  design injects the **whole P0 set at once** — 13 snippets. At 150 words each that is ~1,950 words,
  call it ~2,600 tokens of static preamble sitting in front of the result rows on every narration
  call. At 55 words each it is ~715 words, ~950 tokens. The second number leaves room for the ledger
  rows; the first competes with them.
- The narration prompt's job is to interpret rows. A knowledge body that outweighs the data it is
  interpreting inverts the "ledger data wins" constraint in practice even if the prose says otherwise.
- Every snippet here is one idea by construction. One idea does not need 150 words. Where a topic
  wanted more room, that is a signal it should have been two outline rows, not one long snippet — and
  in the two places that came up (D1, E1) the extra material is a *qualifier* on the main idea, which
  compresses well.
- 40 words is a floor, not just a style note. Below that the snippets stop carrying the "why" and
  degrade into slogans, which paraphrase badly through a 32B model.

Measured against the drafts below: all 25 snippets land between 49 and 74 words. P0 set (12 snippets)
totals 737 words. (Counts recomputed mechanically in ticket 3 and recorded per-file in
`docs/knowledge/`; they run a few words above the hand counts printed under each draft below.)

Ticket 4 should treat this as a starting budget, not a fixed one. If real measurement shows headroom,
the cheapest way to spend it is adding P1 snippets, not lengthening existing ones.

## Corrections to the outline's UAE notes

Two of the outline's UAE notes were written from survey-level assumption and did not survive
verification. Flagging here rather than silently drafting around them, since the outline is the
canonical topic list and `@tech-lead` / ticket 4 reviewers will read it alongside this file.

1. **"No unemployment insurance backstop" (E1) is out of date.** The UAE has had a mandatory
   Involuntary Loss of Employment (ILOE) scheme since 2023: 60% of *basic* salary for up to three
   months, subject to a payout cap, a 12-month minimum subscription, and exclusion of resignation and
   dismissal-for-cause. It pays on top of end-of-service gratuity rather than replacing it. So a
   backstop exists — it is just short, partial, and conditional. E1 below is written against
   "short and conditional" rather than "absent", which is both more accurate and more useful. The
   residency half of the outline's note stands unchanged and is the part that actually moves the
   number.
2. **"Fixed-term loans mostly aren't accelerable without a settlement fee" (D1) overstates it.**
   They are accelerable, and the fee is capped by CBUAE at 1% of the *outstanding* principal or
   AED 10,000, whichever is lower. That is a bounded, computable cost, not a lock. D1 is therefore
   written as "check the settlement cost before reordering" rather than "you can't reorder", which is
   a materially different instruction to give the model.

Neither correction changes any snippet's priority or the section structure.

## A. Envelope-budgeting foundation

### A1 — Give every dollar a job (P0)

Money that arrives without a purpose assigned to it is not spare, it is undecided. Envelope budgeting
means naming what each amount is for at the moment it lands, so the decision gets made once, on
purpose, rather than repeatedly and by default at the point of spending. A balance with nothing
assigned to it is an open question, not a surplus.

*(58 words)*

### A2 — Budget the money you have (P0)

Allocate from the balance actually sitting in the accounts, not from income expected later in the
month. This is the single choice that makes envelope budgeting stable: a plan built on money that has
already arrived cannot be broken by a payment landing late or smaller than expected. Expected income
becomes budgetable when it shows up, not before.

*(58 words)*

### A3 — Roll with the punches (P0)

Overspending one category is a signal to re-plan, not a verdict. The correct response is to move money
from another category to cover it, which keeps the total honest and forces the tradeoff into the open.
A budget that is never adjusted mid-month was not accurate, it was just unexamined. Frequent small
reallocations are the system working.

*(57 words)*

### A4 — True expenses / sinking funds (P0)

Annual and irregular costs — insurance, renewals, school fees, maintenance, the flight home — are
predictable in total even when unpredictable in timing. Dividing the yearly figure into monthly
allocations turns them from shocks into line items. Most months that money looks idle; that is what it
is for. The alternative is a budget that is quietly wrong eleven months a year.

*(61 words)*

### A5 — Age of money / buffer (P1)

Age of money is how long funds sit before being spent. Spending this month from money earned last
month, rather than from money arriving in three days, removes timing pressure from every other
decision. One full month of expenses held as buffer is the practical target — beyond that the metric
stops telling you much.

*(54 words)*

## B. Budgeting frameworks

### B1 — Zero-based budgeting (P1)

Zero-based budgeting means every unit of income is assigned somewhere until nothing is left
unallocated. Zero is not a target balance in the bank; it is a target of nothing *unassigned*. It is
the same discipline as giving every dollar a job, stated as an accounting property rather than a
habit — which makes it easy to check and easy to misread as "spend it all".

*(64 words)*

### B2 — 50/30/20 (P1)

The 50/30/20 rule splits income you actually receive into roughly half needs, thirty percent wants,
twenty percent saving and debt paydown. It is a coarse sanity check on proportions, not a way to
allocate money — it says nothing about which specific spending is which, or what to do when a category
runs out. Useful for a yearly gut check, useless as a monthly mechanism.

*(64 words)*

### B3 — Where each framework breaks (P1)

Percentage rules assume steady income; with variable earnings the same percentages produce a different
plan every month, which is not a plan. And a high fixed-cost ratio — expensive rent, a large fixed
loan instalment — makes 50/30/20 report failure when the budget is working fine and simply has a
different shape. Frameworks describe typical situations, not correct ones.

*(60 words)*

## C. Cash-flow hygiene

### C1 — Fixed vs variable vs discretionary (P0)

Fixed costs are contractual and change only by renegotiating or leaving — rent, loan instalments,
insurance. Variable costs are necessary but elastic in amount, like groceries and fuel. Discretionary
spending is optional at the moment of purchase. Only the third responds to intention in the short
term, which is why willpower-based budgeting fails when the real problem sits in the first bucket.

*(59 words)*

### C2 — Subscription creep (P0)

Recurring charges are individually too small to trigger a decision and collectively large enough to
matter. Annualise before judging any of them: a monthly charge times twelve is the number to react to,
not the monthly figure. They also accumulate silently, since nothing prompts a review — so the review
has to be scheduled rather than triggered.

*(56 words)*

### C3 — Small-ticket drift (P0)

Dining out, delivery, and convenience purchases are each too small to feel like a decision, which is
exactly why they aggregate into a top-three category without anyone choosing that. The useful view is
the monthly total and the transaction count, not the individual amounts. Frequency is usually the
lever worth pulling, not the per-purchase amount.

*(55 words)*

### C4 — Lifestyle inflation (P1)

Spending tends to expand to match income, so a raise often leaves nothing behind a year later. The
counter-move is allocating the increase before it arrives — to savings, a reserve, or debt — so the
higher amount never passes through the general-spending pool. What is never unassigned is never
absorbed.

*(51 words)*

### C5 — Irregular income smoothing (P1)

With variable income, budget from a conservative trailing baseline — something like the lowest of the
last several months — rather than the most recent figure. Hold anything above that baseline as buffer
for the thin months instead of raising the baseline. Good months fund bad months; the plan should not
move every time earnings do.

*(56 words)*

### C6 — One-off vs trend (P1)

A single high month in a category is usually an event, not a pattern — a repair, a trip, an annual
renewal. Two consecutive periods are suggestive; three make a trend worth acting on. Before treating a
change as real, check whether a known one-off explains it, and whether the periods being compared
contain the same number of paydays and weekends.

*(61 words)*

## D. Debt

### D1 — Avalanche vs snowball (P0)

Paying the highest interest rate first costs the least; paying the smallest balance first is easier to
sustain. The tradeoff is arithmetic against adherence, and adherence often wins in practice. Both
assume the payoff order is yours to choose, which is true of revolving balances and of fixed-term
loans only after checking the early-settlement cost — small and capped in the UAE, but real and worth
computing first.

*(68 words)*

**Source note (web-verified, 2026-07-29):** CBUAE caps early settlement of personal, auto and home
loans at 1% of outstanding principal or AED 10,000, whichever is lower — see
[CBUAE Rulebook, bank loans to individual customers](https://rulebook.centralbank.ae/en/entiresection/4406)
and [Bayut summary](https://www.bayut.com/mybayut/early-settlement-fees-mortgages/). This corrects the
outline's assumption that instalment debt is effectively non-accelerable; it is accelerable at a
bounded cost.

### D2 — Debt vs saving priority (P0)

Once a starter reserve exists, the ordering heuristic is rate-based: money goes wherever it earns or
saves the most, which for high-rate debt is almost always paydown. The starter reserve comes first
regardless, because without it the next unexpected expense goes back onto the same debt. Where a job
loss also starts a residency clock, that argument gets stronger, not weaker.

*(59 words)*

### D3 — Revolving-interest mechanics (P0)

**This describes credit cards specifically and does not apply to fixed-term instalment loans.** Paying
the full statement balance by the due date costs nothing. Paying the minimum on time is a different
behaviour: the balance carries, interest accrues on it, and the interest-free window on new purchases
is usually lost until the balance clears. "On time" and "in full" are not the same thing.

*(63 words)*

**Source note (web-verified, 2026-07-29):** UAE card mechanics match this shape — CBUAE caps card APR
at 36% on revolving balances, typical minimum payment is 5% of outstanding or AED 100 whichever is
greater, and carrying a balance forfeits the grace period on new purchases. See
[CBUAE Rulebook art. 11](https://rulebook.centralbank.ae/en/rulebook/article-11-interest-rates-commissions-and-banking-service-charges)
and [Emirates NBD card fees schedule](https://www.emiratesnbd.com/-/media/enbd/files/credit-cards/emiratesnbd_credit_card_fees_charges.pdf).
The explicit card-only label is the outline's recommended option, chosen over a companion snippet so
it is cheaper under prompt budget. See D4 for the instalment-side framing that keeps the model from
generalising revolving mechanics to a loan.

### D4 — Debt as negative cash flow (P2)

A fixed instalment is a fixed cost before it is a debt: it shrinks the budget's usable surface every
month until it ends. That is also why the headline rate on an instalment loan is not the number that
matters day to day — the monthly payment and the remaining term are. Borrowing is priced in more than
one way; the cash leaving each month is the part the ledger can see.

*(72 words)*

**Source note (web-verified, 2026-07-29):** the "headline rate is not the comparable number" point is
UAE-load-bearing — personal loans here are commonly quoted at a *flat* rate on the original principal,
which is roughly half the equivalent reducing-balance rate, so quoted rates are not comparable across
products. Banks are separately constrained by a 50% debt-burden-ratio cap. Sources:
[CBUAE Rulebook art. 3, important ratios](https://rulebook.centralbank.ae/en/rulebook/article-3-important-ratios),
[Emirates NBD DBR explainer](https://www.emiratesnbd.com/en/help-and-support/your-debt-burden-ratio).
This snippet is also where the outline's "don't assert interest is the only way borrowing is priced"
requirement is satisfied — deliberately, since it keeps that phrasing out of the P0 set where it would
have cost words in D1 or D3.

## E. Reserves

### E1 — Emergency fund sizing (P0)

The usual heuristic is three to six months of essential expenses, adjusted by what would actually
happen if income stopped. Dependants, a high fixed-cost ratio, and unstable income all push the number
up. So does residency tied to employment: a job loss then puts a deadline and possible relocation costs
on the same balance, and any statutory unemployment cover is short, partial and conditional. Treat the
low end of the range as a floor.

*(74 words)*

**Source note (web-verified, 2026-07-29):** two UAE specifics behind this.
(a) Residency — grace periods after employment-visa cancellation run roughly 30–180 days depending on
visa and skill category, are not routinely extendable, and start from cancellation processing rather
than the last working day
([Fragomen](https://www.fragomen.com/insights/gulf-news-uae-visa-grace-period-how-long-can-you-stay-after-employment-visa-cancellation.html)).
(b) Safety net — the ILOE scheme pays 60% of *basic* salary for up to three months, requires 12 months'
prior subscription, excludes resignation and dismissal for cause, and pays alongside rather than
instead of end-of-service gratuity
([ILOE official](https://www.iloe.ae/),
[Khaleej Times](https://www.khaleejtimes.com/life-and-living/uae-unemployment-insurance-scheme-how-to-claim-iloe-benefits-eligibility-criteria)).
Hence "short, partial and conditional" rather than the outline's "no backstop". The snippet names the
factor rather than the country, per the outline's location-aware instruction.

### E2 — Where to hold it (P1)

Two properties matter and nothing else does: it has to be reachable within days, and it has to be
somewhere that daily spending will not quietly erode. Separation from the current account does most of
the work. Anything that trades access for return has stopped being an emergency fund and become
something else, whatever it is called.

*(56 words)*

### E3 — When to draw on it (P1)

An emergency is unexpected, necessary, and urgent — all three. A known annual cost is not an emergency,
it is a sinking fund that was not funded. When the reserve is drawn down, refilling it is the next
budget's first claim, ahead of discretionary categories, because the thing that just happened proved
the reserve was doing real work.

*(58 words)*

## F. Review habits

### F1 — Reconciliation cadence (P1)

Reconciling means checking recorded balances against what the accounts actually say, on a regular
rhythm rather than when something looks wrong. It is what makes every other number trustworthy: an
unreconciled ledger produces category totals that are confidently incorrect. Weekly is usually enough,
and the value is mostly in the regularity rather than the frequency.

*(54 words)*

### F2 — Category hygiene (P2)

Too many categories and every one of them is noise; too few and the thing you are looking for is
hidden inside a larger one. The right granularity is the level at which you would actually change
behaviour. Consistent naming and stable boundaries matter more than the number of categories, because
comparison across months is the whole point.

*(58 words)*

### F3 — Reading a month honestly (P2)

Compare against a trailing average of several months rather than last month alone; any two adjacent
months differ for reasons that mean nothing. Check the mechanics before the interpretation — how many
paydays and weekends the period contained, whether an annual charge landed inside it, whether a
transaction posted on the far side of a boundary.

*(56 words)*

## Boundary

### X1 — Scope and refusal (P0)

Answer questions about what the ledger shows and about general budgeting practice. Decline investment,
tax, insurance, and credit-score questions, and do not name products, institutions, or rates or judge
whether a product is Sharia-compliant. Costs and payments can always be described in plain cash terms
from the recorded data. When declining, say what is out of scope and answer the ledger part.

*(62 words)*

Kept as one snippet per the outline's recommendation, so the model has an explicit refusal path rather
than improvising one. It is P0 by function, not by topic: it is the only snippet whose absence changes
what the assistant will say rather than how well it says it.

## Handoff to ticket 4

- **P0 set (12):** A1–A4, C1–C3, D1–D3, E1, X1. 737 words, roughly 950–1,000 tokens. Enough to wire
  up and evaluate on its own.
- **P1 set (10):** A5, B1–B3, C4–C6, E2, E3, F1. Drafted and ready. Per the outline, if the budget
  forces cuts among P1, E2 and E3 survive ahead of the B and F rows.
- **P2 set (3):** D4, F2, F3. Drafted, but **do not inject these until real token cost is measured** —
  this is the outline's own recommendation and it still holds. One caveat: D4 is not purely optional
  the way F2 and F3 are. It carries the "borrowing is priced in more than one way" point that keeps
  the model from narrating a flat-rate instalment loan with revolving-card logic. If D4 gets cut, that
  clause needs folding into D3 or D1 rather than disappearing.
- **Not drafted, deliberately:** nothing on the outline's flagged list. Islamic-finance content is
  covered by refusal in X1 only, per the outline — no explanatory snippet, since permissibility is a
  religious and regulatory judgement rather than a budgeting one.
- **Open for ticket 4, not resolvable here:** whether all P0 snippets go in on every narration call or
  whether some cheap keyword gate selects a subset. That is a measurement question. The lengths above
  are set so that "all of P0, every call" is affordable, which means the simple design is available if
  measurement supports it.
