/**
 * Follow-up suggestions (ADR-0024, `[chat-model]` Tier 1 output 8).
 *
 * Two or three questions the user might ask next, offered under the answer as
 * clickable chips. The load-bearing property, and the whole reason this is a
 * module and not a prompt line: **a suggestion is an input path**. Clicking one
 * makes it the next question, which goes straight into the SQL-generation
 * prompt. Row text is third-party-controlled post-YNAB-import, so a suggestion
 * a model wrote from those rows would be attacker-chosen text the user is
 * invited to click — the forgeable control channel ADR-0023 refused for
 * `present`, with a worse payoff.
 *
 * So nothing here reads model output. The templates are a closed list in code,
 * and their slots take only two kinds of value:
 *
 *   1. Date ranges this module resolved itself from the generated SQL, against
 *      the server's own clock.
 *   2. Category and account literals that are already inside ADR-0008 /
 *      ADR-0018's injected closed vocabulary — the same strings that already
 *      reach the SQL prompt by that route, so no taint path opens that was not
 *      already open.
 *
 * Nothing from `rows` and nothing from narration is ever interpolated, and the
 * user's own question text is not spliced in either: a template renders from
 * slots or it does not render.
 *
 * Same posture as `lib/chatHedge.ts` one step further out — decide server-side
 * from the SQL and the question, never delegate to model judgement.
 *
 * **Fails closed and silently.** A SQL shape this cannot resolve produces no
 * suggestions, no error and no frame. ADR-0024 makes this the one place in the
 * pipeline allowed to degrade without saying so, because the absence of a
 * suggestion is a non-event.
 *
 * Everything is pure. It gates nothing, skips nothing, and touches no number.
 */

import { balanceIntentMatch } from './chatBalanceIntent'
import { extractAccountPredicates } from './chatAccountVocabulary'
import { extractCategoryPredicates } from './chatCategoryVocabulary'

/**
 * The closed template set. Order is ADR-0024's priority order, and
 * `TEMPLATE_ORDER` below is the single place it is written down.
 */
export type SuggestionTemplate =
  /** Same filters, the period immediately before this one. */
  | 'same-filter-prior-period'
  /** Same filters, a wider window (a month becomes its year). */
  | 'same-filter-longer-window'
  /** Same period, broken down by category. */
  | 'same-period-breakdown'
  /** Same period and shape, a different account in the ledger. */
  | 'sibling-account'

export const TEMPLATE_ORDER: readonly SuggestionTemplate[] = [
  'same-filter-prior-period',
  'same-filter-longer-window',
  'same-period-breakdown',
  'sibling-account',
]

export type Suggestion = { text: string; template: SuggestionTemplate }

export type SuggestionsFrame = { type: 'suggestions'; questions: Suggestion[] }

/** ADR-0024: at most three, in `TEMPLATE_ORDER`. */
export const MAX_SUGGESTIONS = 3

// ── Period resolution ────────────────────────────────────────────────────────

/**
 * A date window the route resolved for itself.
 *
 * `month` and `year` are kept as distinct kinds rather than collapsed into a
 * day range because the templates need to *name* the period back to the user
 * ("in June 2026"), and reconstructing "this range happens to be a calendar
 * month" from two ISO days is exactly the kind of inference this module is
 * meant not to make twice.
 */
export type ResolvedPeriod =
  | { kind: 'month'; ym: string }
  | { kind: 'year'; y: string }
  /** Inclusive ISO day bounds. */
  | { kind: 'range'; start: string; end: string }

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * A date column reference, optionally table-qualified.
 *
 * The word boundaries are load-bearing: `date` occurs as a substring of
 * `updatedAt`, and without them `updatedAt >= '2026-01-01'` would be read as a
 * transaction-date bound and shift every derived window.
 */
const DATE_COL = String.raw`(?:"?\w+"?\s*\.\s*)?"?\bdate\b"?`

// `strftime('%Y-%m', date) = 'YYYY-MM'` — a month written as a literal, which
// is what the SQL prompt teaches for a named month (see its Date rules).
const LITERAL_MONTH_RE = new RegExp(
  String.raw`strftime\s*\(\s*'%Y-%m'\s*,\s*${DATE_COL}\s*\)\s*=\s*'(\d{4}-\d{2})'`,
  'i',
)

// `strftime('%Y', date) = 'YYYY'`.
const LITERAL_YEAR_RE = new RegExp(
  String.raw`strftime\s*\(\s*'%Y'\s*,\s*${DATE_COL}\s*\)\s*=\s*'(\d{4})'`,
  'i',
)

// `strftime('%Y-%m', date) = strftime('%Y-%m', date('now', '-1 month'))` — the
// relative form the prompt teaches for "last month"/"this month". The modifier
// is optional (bare `date('now')` is the current month) and its sign is
// captured, so the window is resolved against the server's clock rather than
// left as an opaque expression.
const RELATIVE_MONTH_RE = new RegExp(
  String.raw`strftime\s*\(\s*'%Y-%m'\s*,\s*${DATE_COL}\s*\)\s*=\s*strftime\s*\(\s*'%Y-%m'\s*,\s*date\s*\(\s*'now'\s*(?:,\s*'([+-]?\d+)\s*months?'\s*)?\)\s*\)`,
  'i',
)

const RELATIVE_YEAR_RE = new RegExp(
  String.raw`strftime\s*\(\s*'%Y'\s*,\s*${DATE_COL}\s*\)\s*=\s*strftime\s*\(\s*'%Y'\s*,\s*date\s*\(\s*'now'\s*(?:,\s*'([+-]?\d+)\s*years?'\s*)?\)\s*\)`,
  'i',
)

const BETWEEN_RE = new RegExp(
  String.raw`${DATE_COL}\s+BETWEEN\s+'(\d{4}-\d{2}-\d{2})[^']*'\s+AND\s+'(\d{4}-\d{2}-\d{2})[^']*'`,
  'i',
)

const LOWER_BOUND_RE = new RegExp(String.raw`${DATE_COL}\s*>=?\s*'(\d{4}-\d{2}-\d{2})[^']*'`, 'i')
const UPPER_BOUND_RE = new RegExp(String.raw`${DATE_COL}\s*(<=?)\s*'(\d{4}-\d{2}-\d{2})[^']*'`, 'i')

/** Any `'now'` the recognisers below did not consume. */
const NOW_RE = /'now'/i

function pad2(n: number): number | string {
  return String(n).padStart(2, '0')
}

function ymOf(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`
}

function isoDay(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return ymOf(d)
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return isoDay(new Date(Date.UTC(y, m, 0)))
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return isoDay(d)
}

function daysBetween(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00.000Z`)
  const b = Date.parse(`${end}T00:00:00.000Z`)
  return Math.round((b - a) / 86_400_000)
}

/**
 * A day range promoted to the calendar period it exactly covers, so a query
 * written as `date >= '2026-06-01' AND date < '2026-07-01'` gets the same
 * "June 2026" wording as one written with `strftime`. Two ways of writing the
 * same month must not produce two differently-worded suggestions.
 */
function normalizeRange(start: string, end: string): ResolvedPeriod {
  const year = start.slice(0, 4)
  if (start === `${year}-01-01` && end === `${year}-12-31`) return { kind: 'year', y: year }

  const ym = start.slice(0, 7)
  if (start === `${ym}-01` && end === lastDayOfMonth(ym)) return { kind: 'month', ym }

  return { kind: 'range', start, end }
}

/**
 * The date window the generated SQL covers, or `null` when it cannot be
 * resolved from the text.
 *
 * Text-level, like every other route-level detector in this pipeline
 * (ADR-0016's line). The recognised set is deliberately the shapes the SQL
 * prompt actually teaches — a literal or relative `strftime` month/year, a
 * `BETWEEN`, or an explicit pair of ISO bounds. Everything else, including
 * `date >= date('now','-30 days')` and any leftover `'now'` this did not
 * consume, resolves to `null` and therefore to no suggestions at all. That is
 * ADR-0024's fail-closed rule: an unresolvable shape is silence, not a guess.
 *
 * Only ONE window may match. Two different period predicates in one statement
 * (a window plus a correlated subquery's own window, say) is ambiguous about
 * which one the suggestion should shift, so it resolves to `null` too.
 */
export function resolvePeriod(sql: string, today: Date): ResolvedPeriod | null {
  const candidates: { period: ResolvedPeriod; consumed: string }[] = []

  const literalMonth = LITERAL_MONTH_RE.exec(sql)
  if (literalMonth) {
    candidates.push({ period: { kind: 'month', ym: literalMonth[1] }, consumed: literalMonth[0] })
  }

  const literalYear = LITERAL_YEAR_RE.exec(sql)
  if (literalYear) {
    candidates.push({ period: { kind: 'year', y: literalYear[1] }, consumed: literalYear[0] })
  }

  const relativeMonth = RELATIVE_MONTH_RE.exec(sql)
  if (relativeMonth) {
    const offset = relativeMonth[1] ? Number(relativeMonth[1]) : 0
    candidates.push({
      period: { kind: 'month', ym: addMonths(ymOf(today), offset) },
      consumed: relativeMonth[0],
    })
  }

  const relativeYear = RELATIVE_YEAR_RE.exec(sql)
  if (relativeYear) {
    const offset = relativeYear[1] ? Number(relativeYear[1]) : 0
    candidates.push({
      period: { kind: 'year', y: String(today.getUTCFullYear() + offset) },
      consumed: relativeYear[0],
    })
  }

  const between = BETWEEN_RE.exec(sql)
  if (between) {
    candidates.push({
      period: normalizeRange(between[1], between[2]),
      consumed: between[0],
    })
  }

  if (candidates.length === 0) {
    // Explicit bounds are checked last and only as a pair: a lone `date >= ...`
    // is an open-ended window with no prior period to name.
    const lower = LOWER_BOUND_RE.exec(sql)
    const upper = UPPER_BOUND_RE.exec(sql)
    if (lower && upper) {
      // `<` is an exclusive upper bound (the prompt's "next month's first day"
      // idiom); `<=` is inclusive. Getting this wrong by a day would silently
      // shift every derived window.
      const end = upper[1] === '<' ? addDays(upper[2], -1) : upper[2]
      if (daysBetween(lower[1], end) >= 0) {
        candidates.push({ period: normalizeRange(lower[1], end), consumed: `${lower[0]} ${upper[0]}` })
      }
    }
  }

  if (candidates.length !== 1) return null

  const [{ period, consumed }] = candidates
  // Any unconsumed `date('now', ...)` means part of the window is still an
  // expression we did not resolve, so the window we did resolve may not be the
  // whole story.
  const remainder = sql.split(consumed).join(' ')
  if (NOW_RE.test(remainder)) return null

  return period
}

// ── Period wording ───────────────────────────────────────────────────────────

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`
}

/** The period as it appears inside a question, article and all. */
export function periodPhrase(period: ResolvedPeriod): string {
  if (period.kind === 'month') return `in ${monthLabel(period.ym)}`
  if (period.kind === 'year') return `in ${period.y}`
  return `between ${period.start} and ${period.end}`
}

/** The window immediately before this one, same length. */
export function priorPeriod(period: ResolvedPeriod): ResolvedPeriod {
  if (period.kind === 'month') return { kind: 'month', ym: addMonths(period.ym, -1) }
  if (period.kind === 'year') return { kind: 'year', y: String(Number(period.y) - 1) }
  const span = daysBetween(period.start, period.end) + 1
  return { kind: 'range', start: addDays(period.start, -span), end: addDays(period.end, -span) }
}

/**
 * The next window out, or `null` when there isn't one.
 *
 * ADR-0024 gates `same-filter-longer-window` on "a month or narrower", so a
 * year widens to nothing: the rung above a year is the whole ledger, which is
 * not a period and reads as a different question.
 */
export function longerWindow(period: ResolvedPeriod): ResolvedPeriod | null {
  if (period.kind === 'month') return { kind: 'year', y: period.ym.slice(0, 4) }
  if (period.kind === 'year') return null
  // A sub-month range widens to the calendar month containing it. A range that
  // straddles two months is already wider than a month, so it is out of gate.
  if (period.start.slice(0, 7) !== period.end.slice(0, 7)) return null
  return { kind: 'month', ym: period.start.slice(0, 7) }
}

/** ADR-0024's `same-filter-longer-window` precondition. */
export function isMonthOrNarrower(period: ResolvedPeriod): boolean {
  if (period.kind === 'month') return true
  if (period.kind === 'year') return false
  return daysBetween(period.start, period.end) + 1 <= 31
}

// ── Filter resolution ────────────────────────────────────────────────────────

/** `GROUP BY` in any casing — "the result is already grouped". */
const GROUP_BY_RE = /\bGROUP\s+BY\b/i
const GROUP_BY_CATEGORY_RE = /\bGROUP\s+BY\b[^;]*?\bcategory\b/i

export type SqlFilters =
  | { kind: 'ok'; category: string | null; account: string | null; grouped: boolean; groupedByCategory: boolean }
  /** A filter is present but its literal is not one the vocabulary vouches for. */
  | { kind: 'unresolved' }

/**
 * The category and account this query filters on, taken only from the injected
 * vocabulary.
 *
 * A predicate whose literal is not *exactly* a stored value resolves the whole
 * query as `unresolved`, which suppresses every suggestion. That is stricter
 * than the grounding guards, which accept a `LIKE '%Travel%'` that plausibly
 * matches: a pattern is fine as a filter the user asked for, but a suggestion
 * has to restate the filter in words, and there is no honest wording for "the
 * category matching some pattern". Fail closed rather than paraphrase.
 */
export function sqlFilters(sql: string, categories: string[], accounts: string[]): SqlFilters {
  const categoryPredicates = extractCategoryPredicates(sql)
  const accountPredicates = extractAccountPredicates(sql)

  const category = categoryPredicates.find((p) => categories.includes(p.literal))?.literal ?? null
  const account = accountPredicates.find((p) => accounts.includes(p.literal))?.literal ?? null

  if (categoryPredicates.length > 0 && category === null) return { kind: 'unresolved' }
  if (accountPredicates.length > 0 && account === null) return { kind: 'unresolved' }

  return {
    kind: 'ok',
    category,
    account,
    grouped: GROUP_BY_RE.test(sql),
    groupedByCategory: GROUP_BY_CATEGORY_RE.test(sql),
  }
}

// ── Question rendering ───────────────────────────────────────────────────────

type QuestionSlots = {
  category?: string | null
  account?: string | null
  period: ResolvedPeriod
  /** `total` asks for one figure; `breakdown` asks for the categories behind it. */
  shape: 'total' | 'breakdown'
}

/**
 * The one sentence builder every template goes through.
 *
 * Both shapes are ordinary spending questions on purpose. ADR-0024 requires
 * every template to produce a question the pipeline can actually answer, so
 * nothing here can render a balance or net-worth noun (ADR-0015), and neither
 * shape needs more than one SELECT (ADR-0011). `renderSuggestion`'s final
 * `balanceIntentMatch` check is the backstop for the one slot that is not ours:
 * a ledger free to name a category "Debt" could otherwise compose a question
 * the route would immediately decline.
 */
function renderQuestion({ category, account, period, shape }: QuestionSlots): string {
  const on = category ? ` on ${category}` : ''
  const via = account ? ` on my ${account}` : ''
  const when = periodPhrase(period)
  return shape === 'breakdown'
    ? `What were my top spending categories${via} ${when}?`
    : `How much did I spend${on}${via} ${when}?`
}

function renderSuggestion(template: SuggestionTemplate, slots: QuestionSlots): Suggestion | null {
  const text = renderQuestion(slots)
  // A suggestion the assistant would then decline is worse than no suggestion
  // (ADR-0024). This is the only check needed: the shapes above are fixed, so
  // the only way a refused question can be composed is through a vocabulary
  // literal that happens to contain a stock noun.
  if (balanceIntentMatch(text)) return null
  return { text, template }
}

// ── The template set ─────────────────────────────────────────────────────────

export type SuggestionInput = {
  question: string
  /** The final generated SQL — the same binding the `result` frame is built from. */
  sql: string
  /** ADR-0008's injected vocabulary, as loaded for this turn. */
  categories: string[]
  /** ADR-0018's injected vocabulary, as loaded for this turn. Not requeried. */
  accounts: string[]
  today: Date
}

/**
 * Up to three follow-up questions, in ADR-0024's priority order.
 *
 * Empty is a perfectly ordinary outcome and the client shows nothing for it.
 */
export function buildSuggestions({ question, sql, categories, accounts, today }: SuggestionInput): Suggestion[] {
  const period = resolvePeriod(sql, today)
  if (!period) return []

  const filters = sqlFilters(sql, categories, accounts)
  if (filters.kind !== 'ok') return []

  const { category, account, grouped, groupedByCategory } = filters
  // A query already grouped by category is answering the breakdown question, so
  // its prior-period and wider-window siblings should ask the same thing about a
  // different window rather than silently collapsing to a single total.
  const shape: 'total' | 'breakdown' = groupedByCategory ? 'breakdown' : 'total'

  const drafted: (Suggestion | null)[] = []

  for (const template of TEMPLATE_ORDER) {
    switch (template) {
      case 'same-filter-prior-period': {
        // Precondition: a resolved date range exists — already true here.
        drafted.push(renderSuggestion(template, { category, account, period: priorPeriod(period), shape }))
        break
      }
      case 'same-filter-longer-window': {
        if (!isMonthOrNarrower(period)) break
        const wider = longerWindow(period)
        if (!wider) break
        drafted.push(renderSuggestion(template, { category, account, period: wider, shape }))
        break
      }
      case 'same-period-breakdown': {
        // Precondition: no category filter, and the result is not already
        // grouped. Either one would make this the question just answered.
        if (category !== null || grouped) break
        drafted.push(renderSuggestion(template, { account, period, shape: 'breakdown' }))
        break
      }
      case 'sibling-account': {
        // Precondition: an account filter is present and the ledger holds more
        // than one account. The sibling is taken off the vocabulary already
        // loaded for this turn — never a second query.
        if (account === null || accounts.length < 2) break
        const sibling = accounts.find((a) => a !== account)
        if (!sibling) break
        drafted.push(renderSuggestion(template, { category, account: sibling, period, shape }))
        break
      }
    }
  }

  const seen = new Set<string>([question.trim().toLowerCase()])
  const questions: Suggestion[] = []
  for (const suggestion of drafted) {
    if (!suggestion) continue
    const key = suggestion.text.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    questions.push(suggestion)
    if (questions.length === MAX_SUGGESTIONS) break
  }

  return questions
}

/**
 * The frame, or `null` when there is nothing to offer.
 *
 * `null` means the route emits no frame at all — not an empty one. ADR-0024's
 * placement rule is "zero or one `suggestions` frame per turn", and an empty
 * array would be a third state the client has to think about.
 */
export function suggestionsFrame(input: SuggestionInput): SuggestionsFrame | null {
  const questions = buildSuggestions(input)
  return questions.length === 0 ? null : { type: 'suggestions', questions }
}
