# ADR-0030: `chart` is a fourth `result` presentation, and a pure re-render of the table's rows

Status: Accepted
Date: 2026-08-18

## Context

`ResultPresent` (`lib/chatResultFrame.ts`, ADR-0023) has three values — `card`, `table`,
`transactions` — picked deterministically by `classifyPresent` from row and column shape. A
two-column `GROUP BY` result (`category`, `total_spent`) currently lands in `table`, which is the
correct-but-plainest rendering of exactly the shape a chart reads best: one dimension, one value.
This is also the shape the SQL prompt's worked examples actually produce, so it is not a
hypothetical.

The visual language for it was adapted from the vendored reference
`docs/reference/beautiful-ui/InsightCards.tsx`, and that file is the reason this needs an ADR rather
than a commit. Its cards do not just draw rows — they assert things: hardcoded deltas (`+12%`,
`-$2,453.44 vs 3 months`), an "anomaly" card framing one bar as abnormal against a threshold,
proactive comparison against a prior period that is nowhere in the result set. ADR-0023 already
refused precisely this, in the clause that killed the card's trend field: *"A trend is a claim that
one column is 'now' and another is 'before', which nothing in the pipeline can verify — the fourth
unverified label in a doc that has already falsified three."* A chart is a much more inviting place
to smuggle that claim back in than a card was, because deltas and thresholds are what chart
libraries are built to draw.

## Decision

**`chart` is added as a fourth `ResultPresent` value, and it renders the same `rows`/`columns` the
`table` presentation would render — nothing more.** Same verified data, no computed deltas, no
period-over-period comparison, no threshold or anomaly framing, no annotation the frame does not
already carry. The only thing that changes between `table` and `chart` for a given result set is the
geometry the numbers are drawn in.

That is what satisfies ADR-0023's constraint rather than violating it. ADR-0023 refused a *trend
field* — a new datum, unverifiable, manufactured by the renderer from two columns whose temporal
relationship nothing established. A line drawn through rows the query itself ordered by date is not
that: every point is a returned value, and the shape between points is the reader's inference from
data they can also read as a table, not the pipeline's assertion. The rule that separates them is
**a presentation may re-encode a value, never derive a new one**. `chart` re-encodes; a trend field
derives.

**Classification** extends `classifyPresent`, checked *after* the existing `card` and `transactions`
checks, so no case ADR-0023 decided changes:

- **breakdown** (bar) — exactly 2 columns, one `text`-kind and one `money`/`number`-kind, row count
  in `[2, CHART_MAX_ROWS]`, `CHART_MAX_ROWS = 10`.
- **trend** (line) — exactly 2 columns, one `date`-kind and one `money`/`number`-kind, same bound.
- Everything else — 3+ columns, one row, more than `CHART_MAX_ROWS` — falls through to `table`,
  unchanged.

v1 is strictly two-column: one dimension, one value. Multi-series compare is not in this pass. It
needs either a wider projection than the SQL prompt teaches or a client-side pivot, and a pivot is a
derivation — the thing the rule above forbids — so it would be its own decision, not an extension of
this one. The `[2, …]` floor is deliberate: a single row is already `card`, and a one-bar bar chart
is a worse card.

**Rendering** is a new `present === 'chart'` branch in `app/chat/_components/ChatResult.tsx`, on
`recharts` — already a dependency, already used the same way by
`app/dashboard/_components/CategoryTrendChart.tsx`. It inherits three things rather than inventing
them:

- Theming from the `--chart-tick` / `--chart-grid` CSS custom properties in `app/globals.css`, so
  there is no JS dark-mode branch, exactly as on the dashboard.
- Bar colour from `colorForCategory` (`lib/category-colors.ts`) — the deterministic WCAG-AA
  hash-of-name palette, which is already generic over a string and not tied to persisted `Category`
  rows, so a chat result whose dimension values were never persisted still colours stably.
- Value formatting from the `formatValue` / `fmtMoney` helpers already in `ChatResult.tsx`. This is
  load-bearing, not tidiness: a chart and a table of the same row set must never disagree on a
  formatted number, which is the same property ADR-0027 bought between the sentence and the table.

The `truncated` note renders below the chart exactly as it does below the table today.

**Nothing upstream moves.** `present` is still chosen by the route from already-cleared rows, still
never emitted by a model (ADR-0023's control-channel argument is untouched), and every guard —
ADR-0017's row-key check, ADR-0020's units, ADR-0027's sign — still runs unconditionally before the
frame is built.

**This amends ADR-0023's `present` enumeration in place, by reference.** ADR-0023 is not edited and
not superseded; both stay Accepted. Same convention as ADR-0027's correction of the `money`
membership rule, and for the same reason: the intent — one frame contract, the route picks the
rendering, advisory styling only — is unchanged, and only the list of renderings grows.

## Consequences

**`present` stays advisory, so a plainer client stays correct.** ADR-0023's property that every
value carries the same `columns`/`rows` holds; a reader that draws a `chart` frame as a table loses
nothing but polish. That is the practical test of "re-encode, not derive", and any future
presentation should have to pass it.

**A visibly wrong chart is now possible where a visibly wrong table already was.** A mis-scoped
aggregate drawn as bars looks more authoritative than the same numbers in a grid. This does not add
a failure mode, it makes an existing one louder — the same trade ADR-0023 accepted when it noted
that an auditable number's first act is to expose narration errors.

**`CHART_MAX_ROWS = 10` is a legibility bound, not a data bound.** An 11-row breakdown is not
truncated to fit a chart; it renders as the full table. Truncation to make a picture work would be a
derivation by omission, and rows narration saw would then be missing from what the user sees.

**Multi-series and any comparison framing stay closed until an ADR opens them.** Not a backlog note
— the reference file makes them the obvious next ask, and the answer is that a delta needs a
verified "before", which is exactly what ADR-0023 established the pipeline cannot supply. Whatever
would change that (a second query, a persisted prior period) is a pipeline decision, not a
rendering one.

**Integer-cents storage, `lib/accounts.ts` and the read-only guard are untouched.** Like ADR-0020
and ADR-0027 this operates on the serialized copy handed to presentation. It is a display rule.
