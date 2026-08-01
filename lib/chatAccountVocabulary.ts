/**
 * Account-name vocabulary grounding for the chat SQL path (ADR-0018).
 *
 * ADR-0018 is this applied to a second column, on ADR-0008's mechanism.
 * ADR-0008 § Decision scoped itself to `Transaction.category` and said so out
 * loud, and `lib/chatCategoryVocabulary.ts`'s header carried the reservation:
 * "Account names have the same shape of problem and are explicitly out of
 * scope here; that is a separate ADR if testing surfaces it."
 *
 * Testing surfaced it. Session 10's query filtered `WHERE a.name LIKE '%credit
 * card%'` against a ledger whose accounts are named nothing of the sort. The
 * query is valid, runs clean, matches nothing, and returns an empty aggregate —
 * the identical false-"no data" shape ADR-0008 was written to kill for
 * categories, arriving through the column ADR-0008 left uncovered. Nothing about
 * the mechanism differs; only the column name does.
 *
 * ADR-0018 gets its own number rather than an ADR-0008 addendum: ADR-0008
 * itself named a separate ADR as the outcome if this surfaced, and ADR-0008
 * already carries an addendum on a different problem (real-value
 * substitution) — folding a second column's scope decision in would put two
 * decisions in one ADR. The mechanism is inherited wholesale; ADR-0018 adds no
 * new stance on grounding-versus-normalising.
 *
 * Structure mirrors `lib/chatCategoryVocabulary.ts` deliberately, so the two
 * read as one mechanism rather than two: vocabulary loaded fresh per request, a
 * cap that fails loudly rather than truncating, a closed-list prompt block, a
 * pre-execution detection scan, a sentinel escape hatch, an ADR-0014-shaped
 * refusal. Where this file differs from that one, the difference is forced by
 * the column and is called out where it happens.
 *
 * Grounding, not normalising — same stance, same reason (ADR-0008, inherited by
 * ADR-0018). Similarity is used in exactly one place, to fill in the "did you
 * mean" half of a refusal a human reads. It never picks a filter value.
 */

import { descriptionSimilarity } from '@/lib/textSimilarity'

/**
 * Maximum number of distinct account names renderable into the prompt.
 *
 * Same rule as ADR-0008's category cap and for the same reason: on exceeding it,
 * escalate rather than truncate, because a partial vocabulary reintroduces the
 * exact bug (a real account missing from the list looks identical to an account
 * that does not exist) while looking like the fix is in place.
 *
 * Set lower than CATEGORY_VOCABULARY_CAP (200) because accounts are a much
 * smaller, much more slowly growing set: the real dev ledger has 10, and
 * app/api/chat/route.ts's SQL_NUM_CTX note sizes its worst case at a 50-account
 * projection. 100 is where "this ledger has gone somewhere unexpected" becomes
 * the likelier explanation for a single-user app, and it still sits inside the
 * measured context budget with room to spare.
 */
export const ACCOUNT_VOCABULARY_CAP = 100

/**
 * The literal the model is told to emit when no stored account corresponds to
 * the one the user named.
 *
 * Exactly ADR-0008's NO_MATCH_SENTINEL device, for exactly its reason (see that
 * constant's note): a closed-list rule that says "copy a literal from this list"
 * has no legal move for "nothing in the list is the thing asked about", and a
 * model resolving that bind reaches for whichever real value looks safest.
 * "Current account" or "Main" is the account-side equivalent of the
 * 'Uncategorized' substitution PR #29 caught — real, grounded, and about a
 * different account than the one the user meant.
 *
 * The sentinel is a legal literal reserved for that case, deliberately not a
 * plausible account name, and the existing groundedness check rejects it with
 * no extra detection logic.
 */
export const NO_MATCH_SENTINEL = '__no_matching_account__'

/** Thrown when the stored account vocabulary exceeds ACCOUNT_VOCABULARY_CAP. */
export class AccountVocabularyTooLarge extends Error {
  constructor(readonly count: number) {
    super(
      `Stored account vocabulary has ${count} distinct names, over the cap of ` +
        `${ACCOUNT_VOCABULARY_CAP}. Refusing to ground the SQL prompt on a partial list.`,
    )
    this.name = 'AccountVocabularyTooLarge'
  }
}

/** Minimal shape of the Prisma client this module needs — keeps it testable. */
export type AccountVocabularySource = {
  account: {
    findMany(args: {
      select: { name: true }
      orderBy: { name: 'asc' }
    }): Promise<{ name: string | null }[]>
  }
}

/**
 * The distinct set of stored `Account.name` values, sorted.
 *
 * Read fresh on every chat turn, no caching, for ADR-0008's reason: an account
 * opened five minutes ago is precisely the one being asked about.
 *
 * Every account is included, inactive ones too. `isActive: false` means the
 * account is retired, not that its transactions vanished — a question about
 * spending on a closed card is a legitimate question, and filtering the
 * vocabulary would turn it into a refusal that names the account as
 * nonexistent, which is a worse lie than the one this guard prevents.
 *
 * Throws AccountVocabularyTooLarge past the cap; the caller must surface that
 * rather than proceeding ungrounded.
 */
export async function loadAccountVocabulary(db: AccountVocabularySource): Promise<string[]> {
  const rows = await db.account.findMany({
    select: { name: true },
    orderBy: { name: 'asc' },
  })

  const names = [
    ...new Set(rows.map((r) => (r.name ?? '').trim()).filter((n) => n.length > 0)),
  ].sort((a, b) => a.localeCompare(b))

  if (names.length > ACCOUNT_VOCABULARY_CAP) throw new AccountVocabularyTooLarge(names.length)
  return names
}

/**
 * The block injected into the SQL system prompt. Empty string when there are no
 * accounts, so the prompt falls through to exactly what it was before.
 *
 * One name per line rather than comma-joined, same as the category block:
 * account names contain commas ("ADCB, Current") often enough that a joined list
 * is genuinely ambiguous about where one name ends.
 */
export function buildAccountVocabularyBlock(accounts: string[]): string {
  if (accounts.length === 0) return ''
  const list = accounts.map((a) => `  '${a.replace(/'/g, "''")}'`).join('\n')
  return `Account vocabulary. Account.name is free text, and these are the ONLY values stored in it:
${list}

- An Account.name filter literal MUST be copied exactly from the list above, character for character, including capitalisation, punctuation and spacing.
- Do NOT invent, translate, abbreviate, expand or tidy an account name, and do NOT filter on a generic description of an account type. 'credit card' is not an account name; whichever listed value names the credit card is.
- Map the user's wording onto the closest listed value ONLY when that listed value genuinely names the same account.
- If NOTHING in the list genuinely corresponds to the account the user named, do NOT substitute a different real account as a stand-in -- that answers a question about someone else's money. Filter on the exact literal ${NO_MATCH_SENTINEL} instead (yes, literally that string, uncapitalised, with the underscores); the server recognises it as "no corresponding account" and will refuse the turn correctly.
- A question that is about accounts in general, or filters on Account.accountType rather than a specific name, needs no name filter at all -- leave it out rather than guessing one.`
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Where this file has to diverge from the category one.
 *
 * `category` is a distinctive column name: `lib/chatCategoryVocabulary.ts` can
 * scan for it with an optional table qualifier and be confident about what it
 * found. `name` is not — `Account.name` and `Category.name` both exist, and a
 * bare `name` in a joined query is genuinely ambiguous. So the qualifier is
 * resolved first: the aliases actually bound to Account in this statement are
 * read off its FROM/JOIN clauses, and only predicates on those are judged.
 *
 * A bare, unqualified `name` counts only when `Account` is the sole table the
 * statement reads, where it cannot mean anything else.
 *
 * Same chosen failure mode as ADR-0008's scan: a shape this does not recognise
 * is simply not checked. The query still runs, still hits the read-only driver,
 * and a genuine miss still lands on ADR-0014's `no-data` refusal rather than a
 * narrated zero. It never rewrites SQL — it only decides whether to run it.
 */
const TABLE_SOURCE_RE = /\b(?:FROM|JOIN)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?((?:\s+(?:AS\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?)?)/gi

/**
 * Words that can follow a table name without being an alias. Without this,
 * `FROM Account WHERE ...` binds the alias "WHERE".
 */
const NOT_AN_ALIAS = new Set([
  'as', 'on', 'using', 'where', 'group', 'order', 'limit', 'having', 'window',
  'join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'full',
  'union', 'intersect', 'except', 'select', 'values', 'returning',
])

const STR = String.raw`'((?:[^']|'')*)'`

/** Undo SQL's doubled-quote escaping. */
function unquote(literal: string): string {
  return literal.replace(/''/g, "'")
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type AccountNameScope = {
  /** Identifiers that refer to the Account table here: `Account` plus any aliases. */
  qualifiers: string[]
  /** Whether an unqualified `name` unambiguously means `Account.name`. */
  bareNameIsAccount: boolean
}

/**
 * Which identifiers in this statement refer to `Account`, and whether a bare
 * `name` can only be its column.
 */
export function accountNameScope(sql: string): AccountNameScope {
  const qualifiers = new Set<string>()
  const tables = new Set<string>()

  for (const m of sql.matchAll(TABLE_SOURCE_RE)) {
    const table = m[1]
    tables.add(table.toLowerCase())

    const trailing = (m[2] ?? '').trim().replace(/^AS\s+/i, '').replace(/"/g, '')
    if (table.toLowerCase() !== 'account') continue

    qualifiers.add(table)
    if (trailing && !NOT_AN_ALIAS.has(trailing.toLowerCase())) qualifiers.add(trailing)
  }

  return {
    qualifiers: [...qualifiers],
    // Sole table, so `name` has exactly one referent. A subquery that reads a
    // second table still populates `tables`, which is the conservative answer.
    bareNameIsAccount: tables.size === 1 && tables.has('account'),
  }
}

export type AccountPredicate = {
  /** The literal as written in the SQL, unescaped. */
  literal: string
  /** Comparison was wrapped in lower()/upper(), so case-folding is intended. */
  caseFolded: boolean
  /** Comparison was a LIKE, so `%`/`_` wildcards are intended. */
  pattern: boolean
}

/** The `Account.name` column reference pattern for this statement's qualifiers. */
function nameRef(scope: AccountNameScope): string | null {
  if (scope.qualifiers.length === 0 && !scope.bareNameIsAccount) return null
  const alts = scope.qualifiers.map(escapeRegExp).join('|')
  const qualifier = alts ? `(?:"?(?:${alts})"?\\s*\\.\\s*)` : ''
  // Bare `name` is only allowed through when it cannot mean another table's.
  const qualifierPart = scope.bareNameIsAccount ? (qualifier ? `${qualifier}?` : '') : qualifier
  if (!qualifierPart && !scope.bareNameIsAccount) return null
  return String.raw`(?:(lower|upper)\s*\(\s*)?${qualifierPart}"?name"?\s*\)?`
}

/**
 * Every `Account.name` filter literal in a generated statement.
 *
 * Predicate shapes recognised: `=`/`==`/`<>`/`!=` in either operand order,
 * `IN (...)`, and `LIKE`, each optionally wrapped in `lower()`/`upper()`. Same
 * set as the category scan, so the two guards cover the same ground.
 */
export function extractAccountPredicates(sql: string): AccountPredicate[] {
  const ref = nameRef(accountNameScope(sql))
  if (!ref) return []

  const equality = new RegExp(`${ref}\\s*(?:=|==|<>|!=)\\s*${STR}`, 'gi')
  const reverseEquality = new RegExp(`${STR}\\s*(?:=|==|<>|!=)\\s*${ref}`, 'gi')
  const inList = new RegExp(`${ref}\\s*(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)`, 'gi')
  const like = new RegExp(`${ref}\\s*(?:NOT\\s+)?LIKE\\s*${STR}`, 'gi')
  const literalRe = new RegExp(STR, 'g')

  const found: AccountPredicate[] = []
  for (const m of sql.matchAll(equality)) {
    found.push({ literal: unquote(m[2]), caseFolded: Boolean(m[1]), pattern: false })
  }
  for (const m of sql.matchAll(reverseEquality)) {
    found.push({ literal: unquote(m[1]), caseFolded: Boolean(m[2]), pattern: false })
  }
  for (const m of sql.matchAll(like)) {
    found.push({ literal: unquote(m[2]), caseFolded: Boolean(m[1]), pattern: true })
  }
  for (const m of sql.matchAll(inList)) {
    const caseFolded = Boolean(m[1])
    for (const lit of m[2].matchAll(literalRe)) {
      found.push({ literal: unquote(lit[1]), caseFolded, pattern: false })
    }
  }
  return found
}

function matchesVocabulary(pred: AccountPredicate, accounts: string[]): boolean {
  if (accounts.some((a) => a === pred.literal)) return true
  if (pred.caseFolded && accounts.some((a) => a.toLowerCase() === pred.literal.toLowerCase())) {
    return true
  }
  if (pred.pattern) {
    // A LIKE pattern is judged on what it would match: strip the wildcards and
    // require the remaining core to occur in a stored name. '%NBD%' against
    // 'Emirates NBD Savings' is a hit; '%credit card%' against a ledger whose
    // cards are named after their banks is not — which is session 10's bug.
    const core = pred.literal.replace(/[%_]/g, '').trim().toLowerCase()
    if (core.length === 0) return true // `LIKE '%'` filters nothing
    return accounts.some((a) => a.toLowerCase().includes(core))
  }
  return false
}

/**
 * Account-name literals in the SQL that no stored name can match, de-duplicated
 * in first-seen order. Empty array means the query is grounded (or filters on no
 * account name at all).
 *
 * With an empty vocabulary this checks nothing: a ledger with no accounts has no
 * list to be grounded in, and every question about it lands on `no-data` anyway.
 */
export function unknownAccountLiterals(sql: string, accounts: string[]): string[] {
  if (accounts.length === 0) return []
  const unknown = extractAccountPredicates(sql)
    .filter((p) => !matchesVocabulary(p, accounts))
    .map((p) => p.literal)
  return [...new Set(unknown)]
}

/**
 * The closest stored names to a literal, best first.
 *
 * Suggestion only — this never selects a filter value, it fills in the "did you
 * mean" half of a refusal a human reads. Falls back to nothing rather than
 * offering an unrelated name.
 */
export function closestAccounts(literal: string, accounts: string[], limit = 3): string[] {
  const bare = literal.replace(/[%_]/g, '').trim()
  return accounts
    .map((a) => ({ a, score: descriptionSimilarity(bare, a) }))
    .filter((s) => s.score >= 0.34)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.a)
}

/**
 * The refusal text for an unmatched account name.
 *
 * ADR-0014's standard: say what was tried and what would help. The denial of the
 * zero is explicit and phrased for accounts — an unmatched account name returns
 * an empty result, and an empty result is not "nothing was spent there".
 */
export function unknownAccountMessage(unknown: string[], accounts: string[]): string {
  // The sentinel is an internal signal, not something the user typed — never
  // quote it back at them (ADR-0008's rule, same reasoning).
  const namedLiterals = unknown.filter((u) => u !== NO_MATCH_SENTINEL)
  const sawSentinel = namedLiterals.length < unknown.length

  const named = namedLiterals.map((u) => `"${u}"`).join(' and ')
  const suggestions = [...new Set(namedLiterals.flatMap((u) => closestAccounts(u, accounts)))]
  const alsoOthers = sawSentinel ? ' (or others you named)' : ''

  const head =
    namedLiterals.length === 0
      ? `I don't have an account matching what you asked about, so I didn't run the query — an unmatched account name returns an empty result, which is not the same as nothing having happened on that account.`
      : namedLiterals.length === 1
        ? `I don't have an account matching ${named}${alsoOthers}, so I didn't run the query — an unmatched account name returns an empty result, which is not the same as nothing having happened on that account.`
        : `I don't have accounts matching ${named}${alsoOthers}, so I didn't run the query — unmatched account names return an empty result, which is not the same as nothing having happened on those accounts.`

  const closest =
    suggestions.length > 0
      ? ` The closest stored ${suggestions.length === 1 ? 'account is' : 'accounts are'}: ${suggestions.map((s) => `"${s}"`).join(', ')}.`
      : ''

  const tail =
    accounts.length <= 12
      ? ` Your accounts are: ${accounts.map((a) => `"${a}"`).join(', ')}.`
      : ` You have ${accounts.length} accounts in total; asking with one of the exact names above will work.`

  return `${head}${closest}${tail}`
}
