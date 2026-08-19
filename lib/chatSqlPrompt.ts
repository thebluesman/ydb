/**
 * The SQL-generation system prompt for the chat path.
 *
 * Lives here rather than inline in `app/api/chat/route.ts` because it is no
 * longer a constant: it has to be rebuilt per request so the model is told
 * what today's actual date is. Being a plain function of `now` also makes the
 * date rules testable without standing up Ollama.
 *
 * Why the date has to be injected at all: genuinely relative phrases ("last
 * month", "this year") were always fine, because the model emits
 * `date('now', '-1 month')` and SQLite resolves it at execution time. But a
 * bare month name with no year ("What was spent on Travel in June?") needs a
 * literal `'YYYY-MM'` on the left of a `strftime` comparison, and the model
 * had nothing to derive the year from except its own training-data sense of
 * the present. Observed 2026-07-29: it resolved "June" to `'2023-06'`, which
 * matched nothing and (correctly, per ADR-0014) came back as a `no-data`
 * refusal rather than a confident $0 — diagnosable, but still wrong SQL.
 *
 * The model is never trusted to know the date; the server computes it.
 *
 * It is also rebuilt per request for a second reason (ADR-0008): it carries the
 * stored `Transaction.category` vocabulary as a closed list, so the model stops
 * guessing filter literals. Both SQL passes in a turn — the first attempt and
 * the repair round-trip — are handed the string this function returns, so the
 * grounding and the date travel together and neither pass can lose one.
 */

import { NO_MATCH_SENTINEL, buildCategoryVocabularyBlock } from '@/lib/chatCategoryVocabulary'
import { buildAccountVocabularyBlock } from '@/lib/chatAccountVocabulary'
import { descriptionSimilarity } from '@/lib/textSimilarity'

/**
 * The predicates this prompt MANDATES on essentially every financial query,
 * none of which a user ever asks for in words (ADR-0028).
 *
 * This is the single source of truth for "predicates the question never needs
 * to ask for". It is read from two places and restated in prose in neither:
 * this file interpolates each fragment into the rule that mandates it (and
 * into nothing else — the worked examples below spell out real SQL, which is
 * what teaches the shape), and `lib/chatVerification.ts` renders the list into
 * the verifier's FILTER check as the closed set of filters that are ledger
 * hygiene rather than evidence of a mismatch.
 *
 * Before ADR-0028 the two prompts were in direct contradiction: the verifier
 * was told "a filter the question never mentioned is a mismatch" while the
 * generator was required to write four such filters every time, which made the
 * verifier condemn its own mandated output. A predicate added to the
 * generator's mandate without being added here reintroduces exactly that bug,
 * so `tests/chatPromptHygieneFilters.test.ts` asserts both builders render
 * every entry.
 */
export const MANDATORY_HYGIENE_FILTERS = {
  /** ADR-0019: a transfer leg is neither income nor spending. */
  transferExclusion: `transactionType != 'transfer'`,
  /** A split parent is a placeholder that sums its own legs. */
  splitLegExclusion: 'parentTransactionId IS NULL',
  /** The expense side of a matched reimbursement pair nets to zero. */
  reimbursementExclusion: 'reimbursementTxId IS NULL',
  /** Unreviewed rows are not yet part of the ledger's answer. */
  statusFilter: `status IN ('committed','reconciled')`,
} as const

/** The four predicates above, in the order the prompts state them. */
export const MANDATORY_HYGIENE_PREDICATES: readonly string[] = Object.values(MANDATORY_HYGIENE_FILTERS)

/** Zero-padded UTC calendar date, `YYYY-MM-DD`. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * The most recent occurrence of a named month that is not in the future, as
 * `YYYY-MM`.
 *
 * This is the resolution rule for a bare month name. Same year if that month
 * has already started, otherwise the previous year — so on 2026-07-29 "June"
 * is 2026-06 and "September" is 2025-09. The current month counts as having
 * occurred even when it is only partway through: asking about "July" on the
 * 29th means this July's transactions so far, not last July's.
 *
 * UTC throughout, matching SQLite's `date('now')` and the rest of the repo's
 * calendar-date handling (`toISOString().slice(0, 10)`), so the two date
 * pathways in a generated query can't disagree about which month it is.
 */
export function mostRecentMonthYm(now: Date, month: number): string {
  const year = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth() + 1
  const resolvedYear = month <= currentMonth ? year : year - 1
  return `${resolvedYear}-${String(month).padStart(2, '0')}`
}

// ── Quarter arithmetic ───────────────────────────────────────────────────────
//
// Why this exists at all, and why it is here rather than left to SQLite:
// "this quarter" and "the same quarter last year" have no `date('now', ...)`
// modifier. SQLite can do "start of month" and "-12 months"; it cannot do
// "start of quarter". The model's alternatives are both bad — `strftime('%m')`
// arithmetic it gets wrong under pressure, or a quarter boundary recalled from
// training data, which is the exact failure `mostRecentMonthYm` was written to
// stop one granularity down. So the server computes the boundaries and hands
// the model literals, on the same terms as the rest of this file: pure, UTC,
// derived from `now`, never from the model's sense of the present.

/** A calendar quarter. `quarter` is 1-4. */
export type Quarter = { year: number; quarter: number }

/** The quarter `now` falls in, UTC. */
export function quarterOf(now: Date): Quarter {
  return { year: now.getUTCFullYear(), quarter: Math.floor(now.getUTCMonth() / 3) + 1 }
}

/**
 * `q` moved by `delta` quarters, negative for backwards.
 *
 * Done on an absolute quarter index rather than by decrementing and fixing up,
 * so a year boundary is not a special case and `-4` (the year-over-year shift)
 * is the same code path as `-1`. `Math.floor` rather than truncation, so it
 * stays correct for years before 0 — irrelevant to this ledger, but a division
 * that is only right for positive inputs is a trap for the next caller.
 */
export function shiftQuarters(q: Quarter, delta: number): Quarter {
  const index = q.year * 4 + (q.quarter - 1) + delta
  return { year: Math.floor(index / 4), quarter: (((index % 4) + 4) % 4) + 1 }
}

/**
 * The half-open date range of a quarter, as `YYYY-MM-DD` literals.
 *
 * Half-open (`>= start AND < endExclusive`) deliberately, because
 * `Transaction.date` is an ISO *datetime* string. A closed range written against
 * a calendar date — `<= '2026-09-30'` — drops every row on the last day of the
 * quarter, since '2026-09-30 00:00:00.000' sorts after '2026-09-30' as a string.
 * That is a silent undercount, not an error, so the prompt teaches the half-open
 * form and this returns the boundaries in exactly that shape.
 */
export function quarterRange(q: Quarter): { start: string; endExclusive: string } {
  const startMonth = (q.quarter - 1) * 3 + 1
  const next = shiftQuarters(q, 1)
  const nextMonth = (next.quarter - 1) * 3 + 1
  return {
    start: `${q.year}-${String(startMonth).padStart(2, '0')}-01`,
    endExclusive: `${next.year}-${String(nextMonth).padStart(2, '0')}-01`,
  }
}

/** Human-readable quarter label for the prompt's prose, e.g. `Q3 2026`. */
export function quarterLabel(q: Quarter): string {
  return `Q${q.quarter} ${q.year}`
}

// ── Week arithmetic ──────────────────────────────────────────────────────────
//
// Why the server computes these rather than leaving "this week" to SQLite, on
// the same terms as the quarter block above.
//
// Observed 2026-08-09: "What transactions were on my salary account this week?"
// generated `date >= date('now','-7 days')` -- a TRAILING window, not the
// calendar week the question meant -- and the Phase A verifier flagged it as a
// mismatch. Nothing in this prompt defined what a week is, so the model picked
// the reading that is easiest to write.
//
// Neither SQLite idiom is safe enough to teach:
//
//   * `date('now','weekday 0','-7 days')` is the commonly-cited "start of this
//     week", and it is wrong on exactly one day. The `weekday N` modifier is a
//     NO-OP when the date is already that weekday, so on the start day itself
//     the `-7 days` is not cancelled and the window silently slides a whole week
//     into the past. One day in seven, the answer is confidently about the wrong
//     week, with nothing in the result to show for it.
//   * `strftime('%W', ...)` looks like the month rule's direct analogue, but
//     week 00 is the days before the year's first Monday, so a year boundary
//     splits a week across two labels and "last week" by subtracting 1 from the
//     week number breaks outright every January.
//
// That is the same shape of failure `mostRecentMonthYm` and `quarterRange` exist
// to stop: well-formed SQL over the wrong dates. So the server hands the model
// literals -- pure, UTC, derived from `now`, never from the model's arithmetic.

/**
 * The half-open date range of a calendar week, as `YYYY-MM-DD` literals.
 *
 * `weeksAgo` counts back from the week `now` falls in: 0 is this week, 1 is last
 * week. Half-open for `quarterRange`'s reason exactly -- `Transaction.date` is a
 * datetime string, so a closed range against a calendar date drops the final
 * day's rows.
 *
 * Weeks start MONDAY (ISO-8601). It is the convention the surrounding calendar
 * tooling uses and it matches the local working week; what matters more than
 * which day is chosen is that one day is chosen here, once, instead of being
 * rediscovered per query by a model that has no reason to be consistent about
 * it. UTC throughout, matching `date('now')` and the rest of this file.
 */
export function weekRange(now: Date, weeksAgo = 0): { start: string; endExclusive: string } {
  const DAY_MS = 86_400_000
  // getUTCDay is 0=Sunday..6=Saturday; shift so Monday is 0.
  const sinceMonday = (now.getUTCDay() + 6) % 7
  const startMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    (sinceMonday + weeksAgo * 7) * DAY_MS
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return { start: iso(startMs), endExclusive: iso(startMs + 7 * DAY_MS) }
}

/**
 * The SQL expression that maps a row's `date` to the Monday its calendar week
 * began on — the bucket key for a weekly GROUP BY.
 *
 * Weekly bucketing is the one week question the two supplied literals cannot
 * answer. "This week" and "last week" are single ranges the server can compute
 * up front; "each of the last four weeks" needs a key computed PER ROW, and
 * there is no literal to hand the model for that.
 *
 * The obvious per-row idiom is `date(<col>, 'weekday 1', '-7 days')`, and it is
 * wrong in exactly the way the block above describes: `weekday N` is a NO-OP on
 * a date that is already that weekday, so every row that actually falls on a
 * Monday is bucketed into the PREVIOUS week. One row in seven lands in the wrong
 * bucket, and since the bucket still exists and still has a plausible total,
 * nothing in the result says so.
 *
 * This form avoids the modifier entirely: it reads the row's weekday as a
 * number and subtracts that many days. `strftime('%w', ...)` is 0=Sunday..
 * 6=Saturday, so `(%w + 6) % 7` is "days since Monday" -- 0 on a Monday, 6 on a
 * Sunday -- and the shift is plain day arithmetic, which has no special case at
 * zero (`date(x, '-0 days')` is the identity), across a month, across a year, or
 * on a leap day. Verified against real SQLite over 1,501 consecutive days
 * (2023-01-01 onwards, with a time component on every value): the result is
 * always a Monday, never after the row's own date, and never more than six days
 * before it. `strftime('%u')` would be more readable but was not used -- it only
 * exists in newer SQLite builds, and a modifier that silently returns NULL on an
 * older one is the same class of bug as the two this whole block exists to stop.
 *
 * Returned as a builder rather than written into the prompt by hand for the same
 * reason the date boundaries are computed here: the expression is exact but
 * fiddly, and a model transcribing it with `%w` alone, or without the `+ 6`,
 * produces valid SQL whose buckets are shifted by a day or six. The prompt tells
 * the model to copy it verbatim, so there is one authored copy of it and this is
 * it.
 *
 * @param dateColumn the date column reference, qualified if the query joins
 *   (`t.date`); the prompt's own examples pass the unqualified default.
 */
export function weekStartExpr(dateColumn = 'date'): string {
  return `date(${dateColumn}, '-' || ((CAST(strftime('%w', ${dateColumn}) AS INTEGER) + 6) % 7) || ' days')`
}

/**
 * A category literal for a worked example, drawn from the real vocabulary.
 *
 * The examples used to filter on the bare literals 'Groceries' and 'Travel',
 * which is precisely the guess ADR-0008 exists to stop — and an example that
 * contradicts the closed-list rule is the worst place to leave one, because
 * few-shot shape beats prose instruction. So when a vocabulary is present, the
 * examples demonstrate values from it.
 *
 * `preferred` is matched by similarity purely to keep the example readable
 * ("groceries" → '🛒 Groceries'); the answer is the *stored* string either way,
 * and when nothing resembles it the example falls back to the first stored
 * value and rewords the question to match. Similarity never picks a filter at
 * request time — only which example to print.
 */
function exampleCategory(categories: string[], preferred: string, exclude?: string): { word: string; literal: string } {
  if (categories.length === 0) return { word: preferred.toLowerCase(), literal: preferred }

  const pool = categories.filter((c) => c !== exclude)
  if (pool.length === 0) return { word: categories[0], literal: categories[0] }

  const best = pool
    .map((c) => ({ c, score: descriptionSimilarity(preferred, c) }))
    .sort((a, b) => b.score - a.score)[0]

  if (best.score >= 0.34) return { word: preferred.toLowerCase(), literal: best.c }
  return { word: pool[0], literal: pool[0] }
}

/**
 * An account literal for the `Account`-join worked example, drawn from the real
 * stored vocabulary.
 *
 * Same device as `exampleCategory` and for the same reason (ADR-0008, applied to
 * the second column by ADR-0018): an example that hardcodes an account name the
 * ledger does not have demonstrates the exact guess the closed-list rule exists
 * to stop, and few-shot shape beats prose.
 *
 * `preferred` is 'Credit Card' because that is the wording session 10 actually
 * used ("credit card"), which is a description of an account type rather than a
 * stored name — the case the example most needs to teach. Similarity picks only
 * which stored value illustrates the example, never a filter literal at request
 * time; when nothing resembles `preferred` the example falls back to the first
 * stored account and rewords the question to match.
 */
function exampleAccount(accounts: string[], preferred: string): { word: string; literal: string } {
  if (accounts.length === 0) return { word: preferred.toLowerCase(), literal: preferred }

  const best = accounts
    .map((a) => ({ a, score: descriptionSimilarity(preferred, a) }))
    .sort((x, y) => y.score - x.score)[0]

  if (best.score >= 0.34) return { word: preferred.toLowerCase(), literal: best.a }
  return { word: accounts[0], literal: accounts[0] }
}

/**
 * A word for the "no corresponding category" worked example, guaranteed not to
 * collide with anything actually stored.
 *
 * Picks the first candidate that is not a substring (case-insensitive) of any
 * stored category name, so the example can never accidentally look like a
 * real match on some ledger. This only selects which word illustrates the
 * example; it plays no part in judging real questions.
 */
function noMatchExampleWord(categories: string[]): string {
  const candidates = ['Sports', 'Skydiving', 'Astrology', 'Beekeeping']
  const lower = categories.map((c) => c.toLowerCase())
  return candidates.find((w) => !lower.some((c) => c.includes(w.toLowerCase()))) ?? candidates[0]
}

/**
 * The generator prompt. Every mandate of one of the four
 * `MANDATORY_HYGIENE_FILTERS` interpolates its fragment from that constant, so
 * the list the verifier exempts (ADR-0028) and the list taught here cannot
 * drift apart — `tests/chatPromptHygieneFilters.test.ts` pins that in both
 * directions.
 *
 * The interpolations were chosen to leave the RENDERED string byte-identical:
 * the prompt's model-facing prose about the hygiene filters, including the
 * `-- (see the guard matrix test)` note on the income example, is deliberately
 * untouched. ADR-0031 measures a verifier-prompt change on its own, and a
 * simultaneous reword here would move the generator's output at the same time
 * and make that eval unattributable.
 */
export function buildSqlSystemPrompt(
  now: Date = new Date(),
  categories: string[] = [],
  accounts: string[] = [],
): string {
  const today = isoDate(now)
  // The worked example is computed from `now` for the same reason the prompt
  // is: a hardcoded literal here would teach the model a stale year the moment
  // the calendar moved past it.
  const june = mostRecentMonthYm(now, 6)
  // Quarter boundaries, computed for the same reason the date is: SQLite has no
  // "start of quarter" modifier, so without these the model either does month
  // arithmetic by hand or recalls a boundary from training data.
  const thisQuarter = quarterOf(now)
  const lastYearQuarter = shiftQuarters(thisQuarter, -4)
  const thisQ = quarterRange(thisQuarter)
  const lastYearQ = quarterRange(lastYearQuarter)
  // Week boundaries, for the reason given above weekRange: both SQLite idioms
  // for "start of this week" have a silent off-by-a-week failure mode.
  const thisWeek = weekRange(now, 0)
  const lastWeek = weekRange(now, 1)

  const vocabularyBlock = buildCategoryVocabularyBlock(categories)
  // Empty vocabulary (a ledger with nothing categorised) renders no block and
  // no vocabulary rule — the prompt is then byte-for-byte what it was before
  // ADR-0008, rather than carrying an empty list the model has to interpret.
  const vocabularySection = vocabularyBlock ? `\n\n${vocabularyBlock}` : ''

  // Account names get the same closed-list treatment as categories, for the same
  // reason and by the same mechanism (see lib/chatAccountVocabulary.ts). Rendered
  // as its own block rather than merged into the category one: they are two
  // different columns with two different exact-copy rules, and one combined list
  // would invite the model to filter a name against the category column.
  const accountBlock = buildAccountVocabularyBlock(accounts)
  const accountSection = accountBlock ? `\n\n${accountBlock}` : ''
  const groceries = exampleCategory(categories, 'Groceries')
  const travel = exampleCategory(categories, 'Travel', groceries.literal)
  const noMatchWord = noMatchExampleWord(categories)
  // The Account-join example. Its shape is load-bearing, not stylistic: the
  // aliased form is one `accountNameScope` in lib/chatAccountVocabulary.ts
  // actually resolves, and the unaliased `FROM "Transaction" JOIN Account ON ...`
  // form this file used to instruct in prose alone is one it does NOT (its
  // FROM/JOIN regex consumes the JOIN keyword as the first table's alias, so the
  // Account source is never seen and the grounding check silently fails open).
  // tests/chatSqlPromptAccountJoinExample.test.ts pins both halves of that.
  const account = exampleAccount(accounts, 'Credit Card')

  // Only shown when there's a vocabulary to be grounded against — with none,
  // there's no closed list for a category to fail to correspond to, and
  // ADR-0008's whole vocabulary section (including this rule) is absent.
  const noMatchExample = categories.length > 0
    ? `

Q: What was spent on ${noMatchWord} in July?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '${NO_MATCH_SENTINEL}' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '${mostRecentMonthYm(now, 7)}' AND status IN ('committed','reconciled')
-- No listed category corresponds to "${noMatchWord}". Do NOT substitute 'Uncategorized' or any other real
-- stored category as a guess -- that answers a different question. Use the sentinel literal above instead;
-- it will correctly match nothing and be refused, rather than silently returning someone else's total.`
    : ''

  return `You are a SQLite query generator. Respond with a JSON object of the form {"sql": "<statement>"}, where <statement> is a single SQL SELECT statement (or WITH ... SELECT) -- no markdown, no explanation, no code fences, no backticks, and nothing outside the "sql" field.

Today's date is ${today}. This is the real current date, supplied by the server. Use it whenever the question depends on when "now" is; do not rely on your own assumption about what year it is.

Schema (readable tables only):
  Account(id, name, accountType, currency, isActive, openingBalance, openingBalanceDate, creditLimit, createdAt, updatedAt)
  Transaction(id, date, amount, description, originalDescription, transactionType, category, accountId, status, notes,
              linkedTransferId, parentTransactionId, reimbursableFor, reimbursementTxId, transferCounterpartAccountId,
              rawSource, createdAt, updatedAt)
  Category(id, name, color)

Tables you MUST NOT query (access is blocked at the driver level): Setting, ChatSession, ChatMessage, ChatVerdict, Budget, VendorRule.
Avoid selecting from sqlite_master or any pragma_* function.${vocabularySection}${accountSection}

Rules:
- SQLite dialect only: use strftime('%Y-%m', date) for month grouping, NOT DATE_TRUNC.
- CRITICAL: "Transaction" is a reserved word in SQLite. Always wrap it in double quotes: "Transaction".
- Transaction.date is an ISO datetime string (e.g. '2024-03-15 00:00:00.000').
- Transaction.amount is an INTEGER number of cents. For user-facing sums, divide by 100.0.
- Transaction.transactionType: 'credit' | 'debit' | 'transfer'.
- Amount sign: negative = debit/out, positive = credit/in. Use transactionType for filtering by type.
- Transfers are NEITHER income NOR spending: a transfer moves money between the user's own accounts and is stored as two rows, one negative leg and one positive leg. A bare sign split therefore counts the outgoing leg as an expense AND the incoming leg as income, inflating both totals by the same amount even though the pair nets to zero. Any income, expense, spending, earnings or net-flow aggregate MUST exclude them: AND ${MANDATORY_HYGIENE_FILTERS.transferExclusion} (equivalently AND transactionType IN ('credit','debit')). The trigger is the AGGREGATE, not the sign branch: this applies whenever the query computes a spending, income, earnings or net-flow figure, whether or not it mentions the sign of amount. In particular a category-filtered spend total -- one that pins the category column and makes no comparison against the sign of amount anywhere -- needs the guard just as much, because a transfer leg can carry a real spend category. When it does, the category sits on the OUTGOING leg only and its counterpart leg stays 'Uncategorized', so the two legs do NOT cancel: SUM(amount) over that category returns the full amount moved, reported as spending, with no arithmetic tell that anything is wrong.
- The mirror case for a category filter: when the question is specifically ABOUT a category the ledger happens to put on transfer rows -- "how much did I pay on my car loan", "what have I put towards the personal loan" -- those transfer rows are the SUBJECT of the question, and excluding them answers a different question. Leave AND transactionType != 'transfer' off for that one. The SQL is otherwise the same shape as the spending question, so this cannot be decided from the query: read it off what is being asked. Those two are illustrations, not the complete set: which categories can appear on a transfer is not fixed -- it is whatever the upstream capture pipeline assigned, and it changes without this prompt changing -- so treat a category name as a hint about intent, never as the thing that settles it. Default to including the guard on a spending question; drop it only when the transfer rows are what is being asked about.
- The mirror case for transfers themselves: when the question is specifically ABOUT transfers -- "how much did I move between my accounts", "how much did I transfer" -- the answer is the VOLUME moved, and a bare SUM(amount) over transactionType = 'transfer' rows CANNOT compute it. The two legs of a transfer are equal and opposite, so they cancel: that sum always evaluates to (approximately) zero no matter how much money actually moved. Zero there is an artefact of how a transfer is stored, not a fact about the ledger. Sum the INFLOW legs only instead: SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0. Each transfer contributes exactly one positive leg whose size is the amount transferred, so that total is the volume moved, counted once. (SUM(ABS(amount)) / 2 is arithmetically the same thing; prefer the CASE form.)
- status values: 'review', 'committed', 'reconciled'. For financial queries prefer WHERE ${MANDATORY_HYGIENE_FILTERS.statusFilter} unless the user asks otherwise.
- Split legs: when parentTransactionId IS NOT NULL the row is a leg; the parent is a placeholder that sums the legs. When aggregating spend, exclude parents (WHERE ${MANDATORY_HYGIENE_FILTERS.splitLegExclusion}) OR include the legs instead, NOT both.
- Matched reimbursement pairs (reimbursementTxId IS NOT NULL on the expense side) net to zero. To compute true net spend, exclude the expense side AND the credit that appears as a reimbursement target. Example guard on the expense side: AND ${MANDATORY_HYGIENE_FILTERS.reimbursementExclusion}. To also skip the paired credit: AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id).
- Always include LIMIT 200 at most.
- For joins ALWAYS use short aliases, on every table, whatever the join is for: FROM "Transaction" t JOIN Account a ON t.accountId = a.id. There is no join where the unaliased form is preferable, so do not write one -- not even when nothing in the query filters on a name. Always qualify the name column too (a.name = '...', never a bare name): Category.name exists as well, so an unqualified name in a joined query is ambiguous and the server cannot tell it is an account filter. See the account-filtered worked example below.
- Alias names carry a sign promise the SQL must keep: an alias containing "spent" or "spending" (total_spent, category_spent, ...) means the value comes back POSITIVE, so negate a raw amount sum feeding it -- SUM(-amount) AS total_spent, never SUM(amount) AS total_spent. An alias that is just "total" or "net" carries no such promise and keeps the raw signed value (negative for an expense). The column name is all the narrator sees, so a "total_spent" column that is still negative is reported inconsistently from one query to the next -- narrated as positive prose next to a table the user can see is negative, or hedged with a parenthetical about sign that should never have been necessary.

One row, one column per figure -- never a compound SELECT:
- NEVER use UNION, UNION ALL, INTERSECT or EXCEPT. Not for any question, not even to stack two aggregates.
- SQLite names a compound result set after its FIRST branch only, whichever of those operators joined the branches. "SELECT SUM(...) AS total_expenses ... UNION ALL SELECT SUM(...) AS total_income ..." returns BOTH rows labelled total_expenses, so the income figure is reported as an expense. The column name is all the narrator sees, so that mislabelling becomes a confidently self-contradictory answer.
- A question asking for several figures is answered with several aliased columns in ONE row, using conditional aggregates. See the multi-figure example below.
- The server rejects any query containing a compound SELECT outright rather than running it.

Comparing two periods:
- A comparison -- "how does this month compare to last", "am I spending more on ${groceries.word} than usual", "this quarter versus the same quarter last year" -- is answered by ONE row with one aliased column per period, using a conditional aggregate per period: SUM(CASE WHEN <period test> THEN -amount ELSE 0 END) / 100.0 AS this_month, SUM(CASE WHEN <other period test> THEN -amount ELSE 0 END) / 100.0 AS last_month. Never two queries, and never a compound SELECT -- see the rule above.
- The period test goes INSIDE the CASE, never in the WHERE clause alone. The WHERE clause must span EVERY period being compared, because it filters the rows both columns are computed from. A WHERE pinned to one period is the commonest way this goes wrong: the other column then sums an empty set and reports a confident 0.00 for a period with real spending in it, and the query looks entirely reasonable.
- Alias each column after the period it covers -- this_month, last_month, this_quarter, same_quarter_last_year. The column name is all the narrator sees, so an unlabelled or misordered pair is reported as a comparison of the wrong two things.
- Every money column in the projection must be divided by 100.0 in the SELECT list, comparison columns included. An average over N periods is written SUM(...) / 100.0 / N, with the / 100.0 FIRST: the server reads the projection to decide which values are still raw cents, and a figure it cannot resolve is refused rather than narrated.
- Do NOT compute the difference, ratio or percentage change yourself. Return the two figures; the comparison is made from them downstream.
- All the usual guards apply to a comparison exactly as they do to a single-period aggregate: it is a spending or income figure, so it excludes transfers, split parents and reimbursed pairs.

Balances are out of scope:
- SUM(amount) over an account is the NET FLOW across whatever period the query filters to -- money in minus money out for those dates. It is never that account's balance, and it is never the amount owed on a liability.
- Account balances, net worth and amounts outstanding are NOT derivable in SQL here. A balance is the account's opening balance combined with every transaction over its whole life under the sign rule for its account type; that arithmetic lives in application code, not in this query. If the question asks for a balance, net worth, how much is owed, how much is left, or anything that needs one, do NOT approximate it with a sum -- answer the flow question you can answer, or return the closest transaction-level aggregate.
- Account.openingBalance must NOT be selected, aggregated, or used in an expression.
- Never use SELECT * (or SELECT a.*) on Account. A star projection returns openingBalance without naming it, and the server rejects any result set that comes back carrying that column. List the columns you actually need instead.
- Never label a result column 'balance', 'net_worth', 'outstanding' or 'owed' (in any casing, on its own or as part of a longer name such as 'total_balance'). The column name is all the narrator sees, so a flow figure labelled as a balance is reported as one. The server rejects such a query outright rather than running it -- name a sum 'total', 'net', 'spent' or similar instead.

Date rules:
- For phrases that are relative to now -- "last month", "this year", "this month", "the last 30 days" -- keep using date('now', ...) so SQLite resolves them at execution time. Do NOT substitute a literal for these.
- For a month named WITHOUT a year -- "in June", "what about March?" -- resolve it to the most recent occurrence of that month that is not in the future, counting the current month as having occurred, and write it as a literal 'YYYY-MM'. Today is ${today}, so "June" means '${june}'. A month later in the calendar than the current month belongs to the previous year.
- Never emit a year you were not given or did not derive from today's date (${today}). If a question needs a year that cannot be derived that way, prefer a relative date('now', ...) expression over guessing one.
- A bare year ("in 2024") or an explicit month and year ("June 2024") is already unambiguous -- use it as written.
- Quarters: SQLite has NO "start of quarter" modifier, so do not try to build one out of date('now', ...) and do not derive quarter boundaries by arithmetic on strftime('%m', date). The server supplies them. Today is ${today}, so the current quarter is ${quarterLabel(thisQuarter)}: date >= '${thisQ.start}' AND date < '${thisQ.endExclusive}'. The same quarter one year earlier is ${quarterLabel(lastYearQuarter)}: date >= '${lastYearQ.start}' AND date < '${lastYearQ.endExclusive}'. "Last quarter" is the three months before '${thisQ.start}'.
- Weeks: "this week" and "last week" mean the CALENDAR week, Monday to Sunday -- not the last 7 days. The server supplies the boundaries, the same as for quarters, so do NOT build them yourself: date('now','-7 days') is a trailing window that answers a different question, date('now','weekday 0','-7 days') silently slides a whole week into the past on the one day of the week it lands on, and strftime('%W', date) breaks across the new year. Today is ${today}, so "this week" is date >= '${thisWeek.start}' AND date < '${thisWeek.endExclusive}', and "last week" is date >= '${lastWeek.start}' AND date < '${lastWeek.endExclusive}'.
- Any OTHER whole week -- "two weeks ago", "three weeks ago", "next week" -- is derived from the "this week" Monday above by shifting a whole number of DAYS: "two weeks ago" is date >= date('${thisWeek.start}','-14 days') AND date < date('${thisWeek.start}','-7 days'), and next week is date('${thisWeek.start}','+7 days') to date('${thisWeek.start}','+14 days'). Multiples of 7 days only, always off that literal, never off date('now'). A fixed day count applied to a date that is already the right Monday is exact arithmetic -- it has no equivalent of the weekday-modifier trap and it carries across month, year and leap-day boundaries -- but it is only exact because the anchor is the supplied literal, so do not start it from a Monday you worked out yourself.
- Weekly BUCKETING -- "each of the last four weeks", "week by week", a weekly breakdown -- groups by the Monday each row's week began on. Use this expression verbatim as the bucket key, copying it character for character: ${weekStartExpr()}. Do NOT write date(date,'weekday 1','-7 days') instead: the weekday modifier does nothing when the date is already a Monday, so every Monday row is filed under the previous week and one row in seven lands in a bucket with a plausible total and the wrong contents. Alias the bucket week_start, GROUP BY and ORDER BY that alias, and still bound the query with an explicit half-open range built from the "this week" literal as above -- the bucket key decides which week a row belongs to, not which weeks the answer covers.
- "The last 7 days" is NOT "this week" and keeps its trailing form (date >= date('now','-7 days')); the same goes for "the last 14 days" and similar. Read which one was asked for: a rolling window and a calendar week overlap but are not the same set of rows, and either one reported as the other is a wrong answer that looks right.
- Write EVERY date range against the date column as half-open -- date >= '<start>' AND date < '<day after the end>'. Transaction.date is a datetime string, so a closed range against a calendar date (date <= '${lastYearQ.endExclusive}') silently drops every row on that final day, because '${lastYearQ.endExclusive} 00:00:00.000' sorts after '${lastYearQ.endExclusive}'. An undercount, with nothing in the result to show for it.
- Same period one year earlier: for a MONTH, compare against strftime('%Y-%m', date('now','-12 months')) -- resolved by SQLite at execution time, so it stays correct. For a QUARTER, use the literal range given above. Do not shift a year by editing the year digits of a literal you were not given.
- If a question is anchored to something the ledger does not record -- "the week before my paycheck hits", "since I started my new job" -- do NOT invent the anchor date and do not infer it from the data. There is no stored payday, and a guessed one produces a precisely-bounded window over the wrong dates. Answer the nearest calendar-anchored question you can state exactly, or return no usable window rather than a fabricated one.

Recap questions:
- A question asking for a RECAP, summary or overview of a period -- "give me a monthly recap", "summarise my spending this quarter", "how did last month go" -- is asking about the shape of that period, not for one number. Answer it with a GROUPED AGGREGATE over the period: category totals (GROUP BY category ORDER BY total ASC/DESC), or month totals within a longer window (GROUP BY strftime('%Y-%m', date)). The top-spending-categories example below is the shape to copy.
- Do NOT answer a recap by selecting raw transaction rows. A list of individual transactions is not a summary of a period, it is the thing a summary replaces -- and only the first rows of a long list ever reach the narrator, so a recap built that way describes an arbitrary slice of the period as though it were the whole of it.
- All the usual guards still apply to a recap: it is a spending figure, so it excludes transfers, split parents and reimbursed pairs exactly as any other spending aggregate does.

Examples:
Q: How many transactions do I have?
A: SELECT COUNT(*) AS total FROM "Transaction" WHERE parentTransactionId IS NULL AND status IN ('committed','reconciled')

Q: How much did I spend on ${groceries.word} last month?
A: SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE category = '${groceries.literal.replace(/'/g, "''")}' AND amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')
-- Negated and aliased total_spent, with an explicit amount < 0 filter -- see the alias rule above. Do
-- NOT drop the amount < 0 filter just because a category is nearly always one sign: a category can
-- still carry the rare positive row (a refund, a correction), and only the filter, not the category
-- alone, guarantees the figure comes back meaning what its alias promises. The transactionType guard
-- still belongs: this is a spending figure, which is the trigger. See the transfer rules above.

Q: What was spent on ${travel.word} in June?
A: SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE category = '${travel.literal.replace(/'/g, "''")}' AND amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '${june}' AND status IN ('committed','reconciled')

Q: How much did I spend on my ${account.word} last month?
A: SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t JOIN Account a ON t.accountId = a.id WHERE a.name = '${account.literal.replace(/'/g, "''")}' AND t.amount < 0 AND t.transactionType != 'transfer' AND t.parentTransactionId IS NULL AND t.reimbursementTxId IS NULL AND strftime('%Y-%m', t.date) = strftime('%Y-%m', date('now','-1 month')) AND t.status IN ('committed','reconciled')
-- Filtering by account means joining Account; this is the shape to copy. Both tables get a short alias
-- and the name column is written QUALIFIED (a.name), never bare: Category.name exists too, so an
-- unqualified name in a joined query is ambiguous and the server cannot tell it is an account filter.
-- The literal is copied exactly from the account vocabulary. Do NOT filter on a description of an
-- account type -- a.name LIKE '%credit card%' is valid SQL that matches nothing on a ledger whose cards
-- are named after their banks, and an empty result is not "nothing was spent".
-- Never SELECT * or a.* here: a star projection returns openingBalance without naming it and the
-- server rejects the result set. Project only the figure you need.
-- The transfer guard is not optional even though the question named no sign: money moved onto or off
-- this account is stored as a transfer leg, and counting it as spending inflates the total.

Q: What are my top 5 spending categories this year?
A: SELECT category, SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled') GROUP BY category ORDER BY total_spent DESC LIMIT 5
-- Aliased total_spent, so the sum is negated to come back positive -- see the alias rule above. ORDER BY
-- total_spent DESC to put the largest expense first now that the column is positive, not ASC.

Q: How much have I spent this week?
A: SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND date >= '${thisWeek.start}' AND date < '${thisWeek.endExclusive}' AND status IN ('committed','reconciled')
-- "This week" is the CALENDAR week, and its boundaries are the literals supplied in the date rules
-- above -- not date('now','-7 days'), which is a trailing window over a different set of rows, and not
-- a weekday modifier you assembled yourself. Half-open, like every other range: >= Monday, < the
-- FOLLOWING Monday. "Last week" is the other supplied pair, used exactly the same way.

Q: How much did I spend two weeks ago?
A: SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND date >= date('${thisWeek.start}','-14 days') AND date < date('${thisWeek.start}','-7 days') AND status IN ('committed','reconciled')
-- A week that was NOT supplied as a literal, derived by shifting the supplied Monday by a whole number
-- of days. Both ends move together, so the window is still exactly seven days and still half-open. Do
-- NOT reach for date('now','-14 days') here -- that is a trailing window ending today, not the calendar
-- week -- and do NOT assemble a Monday with a weekday modifier.

Q: How much did I spend in each of the last 4 weeks?
A: SELECT ${weekStartExpr()} AS week_start, SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND date >= date('${thisWeek.start}','-21 days') AND date < '${thisWeek.endExclusive}' AND status IN ('committed','reconciled') GROUP BY week_start ORDER BY week_start
-- A weekly breakdown: one row per week, keyed by the Monday that week began on. The bucket expression is
-- copied verbatim from the date rules above -- it subtracts "days since Monday" rather than using
-- 'weekday 1', which would file every Monday row under the previous week. The WHERE clause still bounds
-- the answer explicitly, anchored to the supplied Monday: three weeks back from it, up to the end of
-- this one. The bucket key says which week a row belongs to; it does not say which weeks are in scope.

Q: What is my total income this month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount > 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) AND status IN ('committed','reconciled')
-- Carries reimbursementTxId IS NULL like every other flow aggregate here, including the paired
-- income-and-expenses examples below. It is one of the mandatory hygiene filters: a question never
-- has to ask for it, and an example that omits it reads as permission to omit it everywhere, which
-- is how this prompt drifted before (see the guard matrix test).

Q: How much did I earn and how much did I spend last month?
A: SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income FROM "Transaction" WHERE transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id) AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')
-- Two figures, two aliased columns, ONE row. Do NOT write this as two SELECTs joined by UNION ALL:
-- the second alias would be discarded and both numbers would come back labelled total_expenses.
-- The transactionType guard is not optional: without it every transfer leg is counted, once as
-- income and once as an expense, and both figures come back too high by the same amount.
-- This example carries BOTH halves of the reimbursement guard, because it reports an expense figure
-- and an income figure together. reimbursementTxId IS NULL drops the expense that was paid back;
-- the NOT EXISTS drops the credit that paid it back, which is not income. Dropping only one half
-- leaves the pair half-counted, so net spend looks too low or income looks too high. Use both halves
-- only when the question is about true net spend or real income -- a question ABOUT reimbursements
-- ("how much was I paid back") wants exactly the rows these two clauses remove, so it uses neither.

Q: What's my total income and total expenses this year?
A: SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses FROM "Transaction" WHERE transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled')

Q: How does my spending this month compare to last month?
A: SELECT SUM(CASE WHEN strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) THEN -amount ELSE 0 END) / 100.0 AS this_month, SUM(CASE WHEN strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) THEN -amount ELSE 0 END) / 100.0 AS last_month FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND date >= date('now','start of month','-1 month') AND status IN ('committed','reconciled')
-- Two periods, two aliased columns, ONE row. The period test is inside each CASE; the WHERE clause
-- covers BOTH months, so both columns are computed from rows that are actually present. Pin the WHERE
-- to one month and the other column reports 0.00 for a month that had spending in it.

Q: Am I spending more on ${groceries.word} than usual?
A: SELECT SUM(CASE WHEN date >= date('now','start of month') THEN -amount ELSE 0 END) / 100.0 AS this_month, SUM(CASE WHEN date < date('now','start of month') THEN -amount ELSE 0 END) / 100.0 / 6 AS average_prior_month FROM "Transaction" WHERE category = '${groceries.literal.replace(/'/g, "''")}' AND amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND date >= date('now','start of month','-6 months') AND status IN ('committed','reconciled')
-- "Than usual" is a comparison against an average, so it is still two columns in one row. The divisor
-- must match the window the WHERE clause opens: six whole months before this one, so / 6. Write the
-- / 100.0 BEFORE the / 6 -- the server reads the projection to decide which figures are still in cents.
-- Do NOT reach for a subquery or a WITH to average the monthly totals: the server cannot resolve the
-- units of a CTE projection and refuses the query outright.

Q: How am I doing this quarter compared with the same quarter last year?
A: SELECT SUM(CASE WHEN date >= '${thisQ.start}' AND date < '${thisQ.endExclusive}' THEN -amount ELSE 0 END) / 100.0 AS this_quarter, SUM(CASE WHEN date >= '${lastYearQ.start}' AND date < '${lastYearQ.endExclusive}' THEN -amount ELSE 0 END) / 100.0 AS same_quarter_last_year FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND date >= '${lastYearQ.start}' AND date < '${thisQ.endExclusive}' AND status IN ('committed','reconciled')
-- The quarter boundaries are the literals supplied in the date rules above, not boundaries you worked
-- out or remembered. Both ranges are half-open (>= start, < the first day of the next quarter), and the
-- WHERE clause spans from the start of the EARLIER quarter to the end of the later one so both columns
-- see their rows.

Q: Across all my accounts, where is my money actually going this month?
A: SELECT category, SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) AND status IN ('committed','reconciled') GROUP BY category ORDER BY total_spent DESC LIMIT 20
-- "Across all my accounts" names NO account, so this filters on none and does not join Account at all.
-- Naming accounts in the question is not the same as naming ONE account: a question that spans the
-- whole ledger is answered by leaving the account filter out, never by picking a plausible account or
-- by grouping per account when the question asked where the money went. Only join Account when the
-- question names a specific account -- see the account-filtered example above.

Q: How much did I move between my accounts this year?
A: SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total FROM "Transaction" WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled')
-- This question wants the transfer total, so here transfers are the subject rather than something to
-- exclude -- but do NOT write it as SUM(amount) over transactionType = 'transfer'. Every transfer is a
-- matched pair of equal and opposite legs, so that sum cancels to (approximately) zero for any ledger,
-- however much was moved. Summing only the positive legs counts each transfer exactly once.${noMatchExample}`
}
