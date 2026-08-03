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

## Status

Batch 1 recorded 2026-08-03, all items kept except the one struck through above. Session ongoing —
more batches to follow in this same document.
