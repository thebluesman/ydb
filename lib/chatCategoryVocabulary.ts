/**
 * Category vocabulary grounding for the chat SQL path (ADR-0008).
 *
 * The bug this closes: `Transaction.category` is free text, and nothing in the
 * pipeline told the model what values it actually holds. So a question about
 * Travel produced `WHERE category = 'Travel'` against a store that holds
 * '✈️ Travel', the query ran cleanly, and the empty aggregate got narrated as a
 * confident zero. An empty result set is not a SQLite error, so the repair
 * round-trip never fired either.
 *
 * Two halves, and the second is the load-bearing one:
 *
 *   1. Prevention — the distinct stored vocabulary is read per request and
 *      rendered into the SQL system prompt as a closed list, with a rule that a
 *      category predicate may only use a literal from it.
 *   2. Detection — the generated SQL is checked against that same list before
 *      it is executed. A literal that isn't in the vocabulary is a loud refusal
 *      ("I don't have a category matching X", closest stored names offered),
 *      never a query that runs and returns nothing.
 *
 * The filter domain is `Transaction.category`, NOT `Category.name`. The two can
 * diverge and the column the SQL filters on is the one that matters (ADR-0008).
 *
 * Grounding, not normalising: no lowercasing/singularising/edit-distance
 * rewrite of the user's word onto a stored one. That is a retrieval layer with
 * the same untestable failure mode ADR-0007 rejected, and it would swap one
 * silent wrongness for another. Similarity is used in exactly one place — to
 * suggest names inside a refusal message a human reads — never to pick a
 * filter value.
 *
 * Scope is categories only. Account names have the same shape of problem and
 * are explicitly out of scope here (ADR-0008 § Decision); that is a separate
 * ADR if testing surfaces it.
 */

import { descriptionSimilarity } from '@/lib/textSimilarity'

/**
 * Maximum number of distinct categories that can be rendered into the prompt.
 *
 * ADR-0008: the block is unbounded in principle, so implementation must cap it
 * — and on exceeding the cap, escalate rather than truncate. A partial
 * vocabulary is worse than none: it reintroduces the exact bug (a real category
 * missing from the list looks identical to a category that doesn't exist) while
 * looking like the fix is in place. So the cap is a loud failure, not a slice.
 *
 * 200 against a real dev ledger of 46 distinct values, single user. The token
 * budget is not the binding constraint — SQL_NUM_CTX (app/api/chat/route.ts) is
 * sized for a 300-category projection — so the cap is set where "this ledger
 * has gone somewhere unexpected" becomes the more likely explanation.
 */
export const CATEGORY_VOCABULARY_CAP = 200

/** Thrown when the stored vocabulary exceeds CATEGORY_VOCABULARY_CAP. */
export class CategoryVocabularyTooLarge extends Error {
  constructor(readonly count: number) {
    super(
      `Stored category vocabulary has ${count} distinct values, over the cap of ` +
        `${CATEGORY_VOCABULARY_CAP}. Refusing to ground the SQL prompt on a partial list.`,
    )
    this.name = 'CategoryVocabularyTooLarge'
  }
}

/** Minimal shape of the Prisma client this module needs — keeps it testable. */
export type CategoryVocabularySource = {
  transaction: {
    findMany(args: {
      select: { category: true }
      distinct: ['category']
      orderBy: { category: 'asc' }
    }): Promise<{ category: string | null }[]>
  }
}

/**
 * The distinct set of stored `Transaction.category` values, sorted.
 *
 * Read fresh on every chat turn — no caching, by decision. Staleness here is a
 * wrong answer, and a category added five minutes ago is precisely the one
 * being asked about (ADR-0008, same argument ADR-0007 used to decline caching
 * snippets). It is one `SELECT DISTINCT` against a local SQLite file on a
 * request that already budgets 120 seconds for two model calls.
 *
 * Empty strings are dropped: `category` defaults to `''` in the schema, and an
 * uncategorised row is the absence of a category, not a category named "".
 *
 * Throws CategoryVocabularyTooLarge past the cap; the caller must surface that
 * rather than proceeding ungrounded.
 */
export async function loadCategoryVocabulary(
  db: CategoryVocabularySource,
): Promise<string[]> {
  const rows = await db.transaction.findMany({
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  })

  const categories = [
    ...new Set(
      rows
        .map((r) => (r.category ?? '').trim())
        .filter((c) => c.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b))

  if (categories.length > CATEGORY_VOCABULARY_CAP) {
    throw new CategoryVocabularyTooLarge(categories.length)
  }
  return categories
}

/**
 * The block injected into the SQL system prompt. Empty string when there is no
 * vocabulary (a fresh ledger), so the prompt falls through to exactly what it
 * was before this feature existed.
 *
 * Rendered as a quoted, comma-free list one per line: category names contain
 * commas and emoji often enough that a comma-joined list is genuinely ambiguous
 * about where one name ends.
 */
export function buildCategoryVocabularyBlock(categories: string[]): string {
  if (categories.length === 0) return ''
  const list = categories.map((c) => `  '${c.replace(/'/g, "''")}'`).join('\n')
  return `Category vocabulary. Transaction.category is free text, and these are the ONLY values stored in it:
${list}

- A category filter literal MUST be copied exactly from the list above, character for character, including any emoji, capitalisation, punctuation and spacing.
- Do NOT invent, translate, singularise, re-case or tidy a category name. 'Travel' is not the same value as '✈️ Travel'.
- Map the user's wording onto the closest listed value: a question about "groceries" means whichever listed value names groceries.
- If nothing in the list plausibly corresponds to the category the user named, do NOT substitute a near-miss and do NOT filter on a guessed literal — the server checks every category literal against this list and will reject the query.`
}

// ── Detection ───────────────────────────────────────────────────────────────

// A reference to the category column, allowing an optional table qualifier
// (`"Transaction".category`) and an optional case-folding wrapper
// (`lower(category)`), which the model reaches for often enough to matter. The
// wrapper is captured because it decides whether a case-insensitive match is
// legitimate: `lower(category) = 'travel'` really does match '✈️ Travel'
// nothing-like, but it *is* a case-folded comparison, so it is judged as one.
const REF = String.raw`(?:(lower|upper)\s*\(\s*)?(?:"?\w+"?\s*\.\s*)?"?category"?\s*\)?`
const STR = String.raw`'((?:[^']|'')*)'`

const EQUALITY_RE = new RegExp(`${REF}\\s*(?:=|==|<>|!=)\\s*${STR}`, 'gi')
const REVERSE_EQUALITY_RE = new RegExp(`${STR}\\s*(?:=|==|<>|!=)\\s*${REF}`, 'gi')
const IN_RE = new RegExp(`${REF}\\s*(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)`, 'gi')
const LIKE_RE = new RegExp(`${REF}\\s*(?:NOT\\s+)?LIKE\\s*${STR}`, 'gi')
const LITERAL_RE = new RegExp(STR, 'g')

/** Undo SQL's doubled-quote escaping. */
function unquote(literal: string): string {
  return literal.replace(/''/g, "'")
}

export type CategoryPredicate = {
  /** The literal as written in the SQL, unescaped. */
  literal: string
  /** Comparison was wrapped in lower()/upper(), so case-folding is intended. */
  caseFolded: boolean
  /** Comparison was a LIKE, so `%`/`_` wildcards are intended. */
  pattern: boolean
}

/**
 * Every category-filter literal in a generated statement.
 *
 * Deliberately a regex scan and not a SQL parse. This is a guard on text the
 * model just produced, run before execution, and its failure mode is chosen: an
 * exotic predicate shape it does not recognise is simply not checked (the query
 * still runs, still hits the read-only driver, and a genuine miss still lands
 * on ADR-0014's `no-data` refusal rather than a narrated zero). It never
 * rewrites SQL — it only decides whether to run it.
 */
export function extractCategoryPredicates(sql: string): CategoryPredicate[] {
  const found: CategoryPredicate[] = []

  // Group order follows the pattern each regex is built from: REF contributes
  // one group (the lower/upper wrapper), STR contributes one (the literal).
  for (const m of sql.matchAll(EQUALITY_RE)) {
    found.push({ literal: unquote(m[2]), caseFolded: Boolean(m[1]), pattern: false })
  }
  for (const m of sql.matchAll(REVERSE_EQUALITY_RE)) {
    found.push({ literal: unquote(m[1]), caseFolded: Boolean(m[2]), pattern: false })
  }
  for (const m of sql.matchAll(LIKE_RE)) {
    found.push({ literal: unquote(m[2]), caseFolded: Boolean(m[1]), pattern: true })
  }
  for (const m of sql.matchAll(IN_RE)) {
    const caseFolded = Boolean(m[1])
    for (const lit of m[2].matchAll(LITERAL_RE)) {
      found.push({ literal: unquote(lit[1]), caseFolded, pattern: false })
    }
  }

  return found
}

function matchesVocabulary(pred: CategoryPredicate, categories: string[]): boolean {
  if (categories.some((c) => c === pred.literal)) return true
  if (pred.caseFolded && categories.some((c) => c.toLowerCase() === pred.literal.toLowerCase())) {
    return true
  }
  if (pred.pattern) {
    // A LIKE pattern is judged on what it would match: strip the wildcards and
    // require the remaining core to occur in a stored value. '%Travel%' against
    // '✈️ Travel' is a hit; '%Groceries%' against a ledger with no groceries
    // category is not.
    const core = pred.literal.replace(/[%_]/g, '').trim().toLowerCase()
    if (core.length === 0) return true // `LIKE '%'` filters nothing
    return categories.some((c) => c.toLowerCase().includes(core))
  }
  return false
}

/**
 * Category literals in the SQL that no stored value can match, de-duplicated in
 * first-seen order. Empty array means the query is grounded (or filters on no
 * category at all).
 *
 * With an empty vocabulary this checks nothing: a ledger with no categorised
 * transactions has no list to be grounded in, and every question about it lands
 * on `no-data` anyway.
 */
export function unknownCategoryLiterals(sql: string, categories: string[]): string[] {
  if (categories.length === 0) return []
  const unknown = extractCategoryPredicates(sql)
    .filter((p) => !matchesVocabulary(p, categories))
    .map((p) => p.literal)
  return [...new Set(unknown)]
}

/**
 * The closest stored names to a literal, best first.
 *
 * Suggestion only — this never selects a filter value, it fills in the "did you
 * mean" half of a refusal a human reads. Falls back to nothing rather than
 * offering an unrelated name: a bad suggestion in a refusal is noise, and the
 * full list is one click away in the ledger.
 */
export function closestCategories(literal: string, categories: string[], limit = 3): string[] {
  const bare = literal.replace(/[%_]/g, '').trim()
  return categories
    .map((c) => ({ c, score: descriptionSimilarity(bare, c) }))
    .filter((s) => s.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.c)
}

/**
 * The refusal text for an unmatched category.
 *
 * ADR-0014's standard: say what was tried and what would help. "I don't have a
 * category matching X, here are the closest ones" is a correct answer to a
 * question the ledger cannot answer; "you spent nothing" is not.
 */
export function unknownCategoryMessage(unknown: string[], categories: string[]): string {
  const named = unknown.map((u) => `"${u}"`).join(' and ')
  const suggestions = [...new Set(unknown.flatMap((u) => closestCategories(u, categories)))]

  const head =
    unknown.length === 1
      ? `I don't have a category matching ${named}, so I didn't run the query — an unmatched category returns an empty total, which is not the same as spending nothing.`
      : `I don't have categories matching ${named}, so I didn't run the query — unmatched categories return an empty total, which is not the same as spending nothing.`

  const closest = suggestions.length > 0
    ? ` The closest stored ${suggestions.length === 1 ? 'category is' : 'categories are'}: ${suggestions.map((s) => `"${s}"`).join(', ')}.`
    : ''

  const tail =
    categories.length <= 12
      ? ` Your categories are: ${categories.map((c) => `"${c}"`).join(', ')}.`
      : ` You have ${categories.length} categories in total; asking with one of the exact names above will work.`

  return `${head}${closest}${tail}`
}
