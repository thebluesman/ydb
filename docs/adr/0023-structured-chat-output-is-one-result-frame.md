# ADR-0023: Structured chat output is one `result` frame, shaped by the route

Status: Accepted
Date: 2026-08-03

## Context

The `[chat-model]` feasibility triage (`docs/research/chat-model-io-brainstorm.md`, 2026-08-03) puts
three output shapes in Tier 1 — buildable inside today's single-shot generate→narrate pipeline, with
no Phase B loop and no Phase C tools (ADR-0012, ADR-0013):

- **Table** (output 3) — a tabular breakdown rather than a prose summary.
- **Card** (output 4) — a compact stat tile in the thread.
- **Annotated transaction list** (output 12) — the line items behind a total, so the number can be
  audited rather than trusted.

Today `POST /api/chat` streams three NDJSON frames: `sql`, `token` (narration prose), and `no-answer`
(ADR-0014). Prose is the only channel for data, so a result set reaches the user as
`JSON.stringify(rows)` filtered through a language model — which is also the mechanism behind
ADR-0010, ADR-0011, ADR-0017 and ADR-0020. All three shapes above are the same request: show the rows.

## Decision

**One new frame type, `result`, carrying the executed result set plus a presentation hint chosen by
the route. Table, card and annotated-transaction-list are three renderings of one contract, not three
frame types.**

```jsonc
{
  "type": "result",
  "present": "card" | "table" | "transactions",
  "currency": "AED",                 // the resolved baseCurrency setting
  "columns": [
    { "key": "total_spent", "label": "total_spent", "kind": "money" }
  ],
  "rows": [ { "total_spent": 1234.5 } ],
  "truncated": { "shown": 20, "total": 137, "dbCapped": false }  // or null
}
```

- `rows` is the exact array narration receives — post-ADR-0017 check, post-ADR-0020 conversion,
  post-`no-data` check, capped at `NARRATION_ROW_CAP`.
- `columns[].kind` is `money` when the key is in ADR-0020's `moneyUnitsPlan(sql).convertKeys`,
  otherwise `date` / `number` / `text` from the first non-null value. Money values are already in
  currency units; the client formats, never converts.
- `columns[].label` is the key verbatim. It is the model's alias, and ADR-0010's rule holds: a label
  is a claim, not a description. The frame does not launder it, exactly as narration does not.
- `present` is advisory styling, not semantics. Every value carries the same `columns`/`rows`; a
  client that renders all three as a table is correct, just plainer.
  - `card` — exactly one row and one column. Label and value come from that cell.
  - `transactions` — more than one row, and every row key is a `Transaction` column name, including
    at least `date` and `amount`.
  - `table` — everything else.

**No trend field on the card.** A trend is a claim that one column is "now" and another is "before",
which nothing in the pipeline can verify — the fourth unverified label in a doc that has already
falsified three. Deferred, not approximated.

**The route picks `present`, deterministically, from the returned rows.** Not a second classification
call (a third inference call for something decidable from data), and explicitly not a typed marker
emitted by the narration model. A marker would put a control channel inside the token stream, and
the containment argument in `app/api/chat/route.ts`'s `[chat-security]` comment rests on there being
none: row text is third-party-controlled post-YNAB-import, and the reader consuming only
`chunk.response` as escaped text is what makes injection cost a wrong sentence rather than a forged
frame. Neither the heuristic nor the marker needs Phase B; the heuristic also does not need
Phase B's safety story.

**Frame order and exclusivity.** `sql`, then `result`, then `token`s. `result` is emitted from the
same stream, after the narration call has returned OK, so ADR-0014's split holds unchanged: a
`no-answer` still arrives alone with nothing after it, and a transport fault is still an HTTP status
rather than a frame beside data. Exactly zero or one `result` frame per turn.

**Every existing guard runs first, unconditionally, in today's order.** The frame is built from the
single `rows` binding after `applyMoneyUnits`, never from a copy taken earlier. `present` is a
rendering choice made on already-cleared data; it gates nothing and skips nothing.

## Consequences

**Nothing new reaches the client.** The `result` frame carries rows narration already sees. That is
the property that makes this Tier 1: no new SQL surface, no new execution path, `executeReadonlyQuery`
untouched, integer cents still integer cents until ADR-0020's conversion point.

**The prose and the table can disagree, and now that is visible.** Output 12 exists to make the
number auditable; the first thing an auditable number does is expose narration errors. Expect that,
the same way ADR-0014 expected the honest-failure rate to look bad at first.

**One row set, one cap.** The frame does not carry rows narration never saw — a table showing 500 rows
under a sentence written from 20 is a worse trust story than a truncated table that says so. Whether
the display cap should be allowed to exceed `NARRATION_ROW_CAP` is a real question and is deliberately
not answered here.

**A narration outage still loses an answer we already have.** The narration `fetch` precedes the
stream, so its failure is a 503 with no `result` frame, despite the rows being in hand. Emitting the
frame earlier would mean a 200 whose headers are already sent when narration dies, which ADR-0014's
error contract cannot express. Left as-is; fixing it is a separate decision.

**Structured output does not survive reload.** `ChatMessage` persists `text`, `sql` and
`nonAnswerReason` — not rows. Adding a column is a schema decision and its own ADR. One constraint on
whatever that decides: persist the emitted frame verbatim, never re-execute `ChatMessage.sql` to
rebuild it. A rebuild is a second execution against a ledger that has since moved, and it would be a
row path that reaches the client without passing the guard chain that produced the original.

**Narration is unchanged.** The prose and the frame are two views of one result set and are allowed
to overlap. Telling the narrator "there is a table below you" is prompt tuning, and this ADR does not
touch the narration prompt (ADR-0007).
