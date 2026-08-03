/**
 * Confidence qualification for a narrated answer ([chat-model] output 5).
 *
 * The product ask: an answer that rests on an assumption the user can't see
 * should say so. The trap, named explicitly when this was scoped: a model told
 * to "hedge when appropriate" hedges everything, and an assistant that qualifies
 * a fully-scoped closed-month total is worse than one that never qualifies
 * anything — the caveats stop carrying information.
 *
 * So the judgement is not the model's. This module decides, from the SQL, the
 * question and the returned rows, whether a *named, specific* caveat applies;
 * the route appends that caveat to the narration prompt when one does, and
 * appends nothing when none does. The system prompt's standing rule (see
 * buildNarrationSystemPrompt) is the other half: work in the caveat if one is
 * stated, and otherwise report the figure plainly with no hedging at all. Same
 * posture as ADR-0020 took for units — decide server-side, don't delegate to
 * model judgement.
 *
 * This is narration wording only. It gates nothing, skips nothing, changes no
 * frame (ADR-0023's `result` is untouched) and never alters a number.
 */

export type HedgeGround =
  /** The window the query covers includes today, so the period isn't over. */
  | 'partial-period'
  /** More rows matched than were narrated, so any "top"/"all" reading is partial. */
  | 'truncated-rows'
  /** The aggregate rests on a handful of transactions. */
  | 'small-sample'

/**
 * An aggregate is the precondition for `partial-period` and `small-sample`: a
 * plain list of rows is exactly what it is, whereas a SUM/AVG/COUNT is a claim
 * about a population, and it is the population's boundaries that can be
 * silently wrong.
 */
const AGGREGATE_RE = /\b(SUM|AVG|COUNT|MIN|MAX|TOTAL)\s*\(/i

export function isAggregateQuery(sql: string): boolean {
  return AGGREGATE_RE.test(sql)
}

/** Result keys that carry a transaction count — the only rows-behind-the-figure signal available. */
const COUNT_KEY_RE = /(^|_)(count|n|num|txns?|transactions?)($|_)|count/i

/**
 * At or below this many underlying transactions, an aggregate is a couple of
 * line items wearing a total's clothes. Three is a judgement call, kept low on
 * purpose: the caveat has to stay rare enough to mean something.
 */
export const SMALL_SAMPLE_MAX = 3

const ISO_DATE_RE = /'(\d{4}-\d{2}-\d{2})[^']*'/g

/** SQLite's "compute the date at query time" forms — always reach today by construction. */
const RELATIVE_DATE_RE = /\bdate\s*\(\s*'now'|\bdatetime\s*\(\s*'now'|\bCURRENT_(DATE|TIMESTAMP)\b|'now'/i

/** Question wording that names an in-progress period. */
const OPEN_PERIOD_QUESTION_RE =
  /\b(this|current)\s+(month|week|year|quarter)\b|\bso far\b|\b(month|year)[-\s]to[-\s]date\b|\b(mtd|ytd)\b|\bthis\s+pay\s*period\b/i

function toIsoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Whether the query's date window runs up to or past today.
 *
 * Text-level, like every other route-level detector in this pipeline
 * (ADR-0016's line: decidable from the SQL alone, or it doesn't get a
 * detector). The upper bound of a "this month" filter is next month's first
 * day, which is strictly after today — that is the case this catches. A closed
 * month's upper bound is on or before today, and produces no caveat.
 */
export function periodReachesToday(sql: string, today: Date): boolean {
  if (RELATIVE_DATE_RE.test(sql)) return true
  const todayIso = toIsoDay(today)
  const literals = [...sql.matchAll(ISO_DATE_RE)].map((m) => m[1])
  if (literals.length === 0) return false
  return literals.some((d) => d >= todayIso)
}

/** The smallest transaction count the rows report, or null if no count column is projected. */
export function smallestCount(rows: readonly Record<string, unknown>[]): number | null {
  let smallest: number | null = null
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!COUNT_KEY_RE.test(key)) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
      // A count column is an integer by construction; a fractional value under
      // a count-ish alias is some other figure and must not drive a caveat.
      if (!Number.isInteger(value)) continue
      smallest = smallest === null ? value : Math.min(smallest, value)
    }
  }
  return smallest
}

export type HedgeInput = {
  question: string
  sql: string
  /** The exact rows narration is handed — post-units, post-cap. */
  rows: readonly Record<string, unknown>[]
  /** True when more rows matched than were narrated. */
  truncated: boolean
  today: Date
}

/**
 * The grounds that apply, in a stable order. Empty is the common case and the
 * intended one: most answers are fully scoped and get narrated with no caveat.
 */
export function hedgeGrounds({ question, sql, rows, truncated, today }: HedgeInput): HedgeGround[] {
  const grounds: HedgeGround[] = []
  const aggregate = isAggregateQuery(sql)

  if (aggregate && (periodReachesToday(sql, today) || OPEN_PERIOD_QUESTION_RE.test(question))) {
    grounds.push('partial-period')
  }

  // Not gated on the aggregate: a truncated list is materially incomplete
  // whatever shape it is, and "your top categories are…" over a cut result set
  // is the misread this exists to stop.
  if (truncated) grounds.push('truncated-rows')

  if (aggregate) {
    const count = smallestCount(rows)
    if (count !== null && count <= SMALL_SAMPLE_MAX) grounds.push('small-sample')
  }

  return grounds
}

const GROUND_TEXT: Record<HedgeGround, string> = {
  'partial-period':
    'the period this covers is still in progress, so the figure is a running total and not a final one',
  'truncated-rows':
    'more rows matched than are shown above, so this is a partial view and not the complete set',
  'small-sample':
    'only a handful of transactions sit behind this figure, so it is easily moved by a single one',
}

/**
 * The caveat block appended to the narration prompt, or '' when nothing
 * applies — in which case the route appends nothing at all and the standing
 * rule in the system prompt tells the model to answer plainly.
 */
export function hedgeInstruction(grounds: readonly HedgeGround[]): string {
  if (grounds.length === 0) return ''
  const list = grounds.map((g) => `- ${GROUND_TEXT[g]}`).join('\n')
  return (
    `\n\nCaveat to state: this answer rests on something the reader cannot see from the figure alone:\n` +
    `${list}\n` +
    `Give the number first and in full, then work this in as one short clause or sentence in your own ` +
    `words. Say it once. Do not add any other qualification, and do not speculate about data you were not given.`
  )
}
