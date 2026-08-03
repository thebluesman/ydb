# Chat model inputs/outputs brainstorm

Working notes from a brainstorm session with Shyam on `[chat-model]` (Notion, Phase "Other"). Goal:
explore what useful **inputs** could feed the chat model(s) beyond today's question + ledger schema,
and what useful **outputs** it could produce beyond narrated text — framed as product/capability
possibilities, not model plumbing. No idea filtered for feasibility yet; that comes later.

Grounding context (see `docs/architecture.md` Open Questions and ADR-0012/0013/0014): today's chat
pipeline is single-shot generate→narrate, not a loop. Target architecture is a bounded ReAct-style
tool-calling loop, phased A→B→C; only Phase A (verification pass) is unblocked. Most of what's below
implies Phase B (the loop itself) and/or Phase C (new code-computed tools beyond `run_sql`).

## Input shapes (kinds of questions/asks)

1. **Lookup/aggregate** — what exists today: "how much did I spend on X," "what's my total income in
   March."
2. **Comparative** — "how does this month compare to last," "am I spending more on groceries than
   average."
3. **Projective/forecasting** — "projected savings by March 2027," "when will I hit $X saved," "will I
   run out of money if I keep this pace."
4. **What-if / scenario** — "what if I cut dining out by half," "what if I got a $500 raise."
5. **Anomaly/pattern detection** — "did anything unusual happen this month," "which subscription crept
   up in price."
6. **Advisory/recommendation** — "where should I cut back," "which debt should I pay off first"
   (already a known failure case, live-tested 2026-08-03).
7. **Goal-tracking** — "am I on track for my emergency fund goal" — assumes a goal construct that may
   not exist in the schema yet.
8. **Visual/report requests** — "show me a chart of X," "give me a monthly breakdown report," "make a
   pie chart of categories."
9. **Explanatory/meta** — "why did my spending go up in June," "explain this transaction," "what does
   this category include."
10. **Action-adjacent** — "flag this as a duplicate," "recategorize all Amazon purchases as X" — a
    request to *change* data, not just read it. Big departure from the read-only posture
    (`lib/prisma.ts` guard, canonical invariant per AGENTS.md).
11. **Free-form conversational follow-up** — "what about groceries specifically" as a follow-up to a
    prior answer. Needs conversation-state/context carry-over, not just the single question in
    isolation.

## Output shapes (kinds of responses)

1. **Narrated text** — today's only output.
2. **Chart/visualization** — line, bar, pie; a structured spec the frontend renders.
3. **Table** — raw-ish tabular breakdown, not prose-summarized.
4. **Structured card/tile** — a compact stat (like a dashboard tile) embedded in the chat thread.
5. **Confidence-qualified answer** — a number plus an explicit "this assumes X, treat it as a rough
   estimate," especially for anything projective.
6. **Multi-step "show your work"** — expose the reasoning/query trail, not just a final answer. Useful
   for trust-building, ties to the original "checks its own work" product ask
   ([[chat-correctness-and-architecture]] trigger note).
7. ~~Proactive/unprompted insight~~ — chat surfaces something without being asked. **Dropped by Shyam
   2026-08-03** — doesn't fit what he wants from this feature.
8. **Follow-up suggestions** — "you might also want to ask..." — cheap way to make it feel more like a
   real assistant.
9. **Action proposal (not execution)** — "I found 3 possible duplicate transactions, want me to flag
   them?" — structured confirm/deny UI element, keeps the read-only posture intact by not auto-acting.
10. **Cross-reference to ledger/dashboard** — a deep link back into the existing UI ("see this in the
    ledger") rather than trying to replace it.

## Input shapes, batch 2

12. **Time-shifted/relative** — "how am I doing this quarter vs the same quarter last year," "what did
    I spend the week before my paycheck hits" — needs date-math beyond the "today" injection that
    already exists.
13. **Cross-account/holistic** — "across all my accounts, where's my money actually going" — spans
    account boundaries explicitly rather than one account at a time.
14. **Category-hierarchy questions** — "how much on all food-related stuff" if food/groceries/dining-out
    are separate categories — implies a taxonomy the model would need to reason over, not just
    literal-match.
15. **Person/vendor-specific** — "how much have I spent at [specific merchant] this year" — vendor as a
    first-class filter dimension, separate from category.
16. **Recurring/subscription detection** — "list my recurring charges," "which subscriptions am I still
    paying for" — pattern-detection over transaction cadence, not a simple filter.
17. **Threshold/alert-style retrospective** — "did I ever go over budget in category X," "when did my
    balance dip below $500" — needs point-in-time balance reconstruction, which is exactly the gap
    ADR-0010/0015 currently decline.
18. **Multi-entity comparison** — "which of my three credit cards do I use most," "compare checking vs
    savings growth."

## Output shapes, batch 2

11. **Exportable artifact** — "give me a CSV of this," reusing the existing CSV-import machinery in
    reverse.
12. **Annotated transaction list** — not just a total, but the actual line items behind it, so the user
    can audit the number themselves.
13. **Narrative summary over a period** — a "monthly recap" style paragraph rather than a single-number
    answer, more editorial than a lookup response.
14. **Comparison visualization** — side-by-side or delta-highlighted chart, distinct from a single chart
    (this vs that, not just "a chart").
15. **Plain refusal with reasoning shown** — already exists as `no-answer`, but surfaced more visibly/
    richly as a "here's specifically why I can't answer this" rather than a terse decline.
16. **Voice/tone variants** — blunt numbers vs. softer "coaching" framing — could be a user-configurable
    output style rather than one fixed narration voice.

## Feasibility triage (2026-08-03)

Grounded in what's actually true today: single-shot generate→narrate pipeline (no tool-calling loop
yet), no `computeBalance`-backed chat path, read-only SQL guard is a hard invariant (`lib/prisma.ts`,
AGENTS.md), no `Goal` model in the schema, categories are flat strings (ADR-0008).

**Tier 1 — buildable now, no architecture change** (prompt/route tweaks, existing tools):
- Inputs: Comparative (2, simple cases), Time-shifted/relative (12), Cross-account/holistic (13),
  Vendor-specific (15, if payee is a distinct stored column).
- Outputs: Table (3), Structured card (4), Confidence-qualified answer (5), Follow-up suggestions (8),
  Cross-reference to ledger (10), Annotated transaction list (12), Narrative summary (13), Plain
  refusal with reasoning (15), Voice/tone variants (16).

**Tier 2 — needs Phase B (the tool-calling loop), no new backend computation:**
- Inputs: Explanatory/meta (9), Free-form follow-up (11), Multi-entity comparison (18) — multi-step
  inspection or session state, not new math.
- Outputs: Chart/visualization (2), Comparison visualization (14), Show-your-work (6), Exportable CSV
  (11) — new output tools the loop can call; capability-neutral, just new tool surface.

**Tier 3 — needs Phase C (new code-computed tools, e.g. `computeBalance`-backed):**
- Threshold/point-in-time balance retrospective (17) — matches `docs/architecture.md`'s existing "no
  code-computed balance path, now the priority" line. Advisory/recommendation (6) mostly lands here too
  (debt payoff needs real balances). Anomaly/pattern detection (5), Recurring/subscription detection
  (16) need real detection algorithms, not SQL generation. Action proposal (output 9) is feasible
  propose-only without touching the read-only guard, but only once a real detector backs it.

**Tier 4 — blocked on a data-model gap, not just architecture phasing:**
- Goal-tracking (7) — no `Goal` construct exists; schema/product decision before any engineering.
- Category-hierarchy (14) — categories are flat strings (ADR-0008); grouping needs a taxonomy that
  doesn't exist yet.

**Tier 5 — blocked on a real product/architecture decision, not effort:**
- Action-adjacent writes (10) — directly conflicts with the read-only posture, a canonical invariant.
  Not "build it later," a "decide if this is ever wanted at all."

**Tier 6 — methodology undefined, feasibility isn't the bottleneck:**
- Projective/forecasting (3), What-if/scenario (4) — before any tool gets built, someone has to decide
  what "projected savings" even means (trend window? excludes transfers? confidence interval?).
  Building the wrong computation confidently is worse than not building it.

**Suggested starting point (not yet decided by Shyam):** Tier 1 output-side items are the cheapest
win — mostly frontend + narration tweaks. Tier 3's balance path is the highest-leverage single
investment, since it unblocks the largest cluster of "real" questions (advisory, threshold, and
indirectly forecasting once real balances exist).

## Status

Batches 1 and 2 recorded 2026-08-03. Brainstorm concluded by Shyam after batch 2. Feasibility triage
added same day. Next step: Shyam to pick a starting tier/item — not yet decided.
