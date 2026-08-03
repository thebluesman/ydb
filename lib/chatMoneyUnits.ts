/**
 * Server-side money-unit normalization for the chat SQL path (ADR-0020).
 *
 * Narration used to be told a value "may already be dollars ... or raw cents —
 * infer from context." That is a 100x-error risk delegated to model judgement.
 * Units are a static type property of named schema columns, not a property of
 * intent — `Transaction.amount` is cents in every query ever written — so this
 * is decidable from the SQL alone, the line ADR-0016 draws for a route-level
 * detector.
 *
 * A route-level classifier walks the final SELECT's projection list and
 * resolves each item against the schema's known money columns
 * (`Transaction.amount`, `Account.creditLimit`, and the two columns the
 * balance-scope guard already bans — `Account.openingBalance`,
 * `Account.lastReconciledBalance`, included here only for completeness since
 * they can never actually reach this classifier). Per item:
 *
 *   (a) Resolves to a money column — bare, qualified, star-expanded over a
 *       single known base table, or wrapped in unit-preserving arithmetic
 *       (unary negation, SUM/MIN/MAX/AVG, or a CASE WHEN whose every branch is
 *       the same money column, negated or not, or a bare numeric literal) —
 *       and contains NO division by 100: raw cents. The value is divided
 *       server-side before narration.
 *   (b) Contains a division by 100 anywhere in the item: already converted,
 *       left untouched. This is a syntactic presence check, not an arithmetic
 *       verifier — a query that divides by 100 in the wrong place computes a
 *       wrong NUMBER, but this classifier cannot and does not try to catch
 *       that. That is a correctness question, not a units question, and the
 *       only thing that can answer it is a known-good expected result — the
 *       golden-query eval harness's job, not this one's.
 *   (c) `COUNT(...)`, or no money column referenced at all: not money, left
 *       untouched, regardless of how complex the expression otherwise is.
 *   (d) Not resolvable to base-table columns — a CTE anywhere in the query, a
 *       star over an ambiguous (multi-table or unresolved) source, or a money
 *       expression whose shape isn't one of (a)'s recognised wrappers and
 *       carries no `/100`: refused as ADR-0014 `unsupported-shape`, not
 *       narrated. Fails CLOSED, deliberately (ADR-0020 § Consequences):
 *       failing open under a narration prompt that no longer hedges on units
 *       would manufacture a confident wrong number, the exact failure being
 *       fixed.
 *
 * Two functions, matching the pre/post-execution split every other guard in
 * this pipeline uses (`balanceScopeViolation` / `balanceScopeRowViolation`,
 * `chatMoneyGuards.ts`'s two detectors): `moneyUnitsPlan` decides from the SQL
 * text alone, before execution, so a refusal short-circuits without spending a
 * query. `applyMoneyUnits` divides values in the already-fetched row set,
 * after execution, using the plan's `convertKeys`.
 */

// ── Schema-known money columns ──────────────────────────────────────────────

/** Table (lowercased) -> its money column names, in their real casing. */
const MONEY_COLUMNS: Record<string, string[]> = {
  transaction: ['amount'],
  account: ['creditLimit', 'openingBalance', 'lastReconciledBalance'],
}

/** Every money column name, lowercased, for the whole-query "any money column referenced" scan. */
const ALL_MONEY_COLUMN_NAMES = Object.values(MONEY_COLUMNS).flat().map((c) => c.toLowerCase())

// ── Table source resolution ─────────────────────────────────────────────────
// Same fixed idiom as `lib/chatAccountVocabulary.ts`'s `accountNameScope`
// ([chat-sql] 9): the alias slot excludes JOIN and its modifiers via lookahead
// so an alias-less table immediately followed by another JOIN doesn't have
// that keyword swallowed into its optional alias group, dropping the next
// table source from detection entirely.

const JOIN_KEYWORDS = 'join|left|right|inner|outer|cross|natural|full'
const TABLE_SOURCE_RE = new RegExp(
  String.raw`\b(?:FROM|JOIN)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?((?:\s+(?:AS\s+)?(?!(?:${JOIN_KEYWORDS})\b)"?[A-Za-z_][A-Za-z0-9_]*"?)?)`,
  'gi',
)

const NOT_AN_ALIAS = new Set([
  'as', 'on', 'using', 'where', 'group', 'order', 'limit', 'having', 'window',
  'join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'full',
  'union', 'intersect', 'except', 'select', 'values', 'returning',
])

type TableSources = {
  /** qualifier (lowercased: table name or alias) -> resolved table (lowercased) */
  qualifiers: Map<string, string>
  /** every distinct base table (lowercased) referenced via FROM/JOIN */
  tables: Set<string>
}

function resolveTableSources(sql: string): TableSources {
  const qualifiers = new Map<string, string>()
  const tables = new Set<string>()

  for (const m of sql.matchAll(TABLE_SOURCE_RE)) {
    const table = m[1].toLowerCase()
    tables.add(table)
    qualifiers.set(table, table)

    const trailing = (m[2] ?? '').trim().replace(/^AS\s+/i, '').replace(/"/g, '')
    if (trailing && !NOT_AN_ALIAS.has(trailing.toLowerCase())) {
      qualifiers.set(trailing.toLowerCase(), table)
    }
  }

  return { qualifiers, tables }
}

// ── Top-level tokenizing (paren/quote-depth aware) ──────────────────────────

/** Split on top-level commas — inside parens and quoted literals are protected. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) { i += 2; continue }
        if (text[i] === quote) { i++; break }
        i++
      }
      continue
    }
    if (c === '(') { depth++; i++; continue }
    if (c === ')') { depth--; i++; continue }
    if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
      i++
      continue
    }
    i++
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** The index of the top-level (depth 0, outside quotes) occurrence of `re`, or -1. */
function findTopLevel(text: string, re: RegExp): { index: number; match: RegExpMatchArray } | null {
  let depth = 0
  let i = 0
  let found: { index: number; match: RegExpMatchArray } | null = null
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) { i += 2; continue }
        if (text[i] === quote) { i++; break }
        i++
      }
      continue
    }
    if (c === '(') { depth++; i++; continue }
    if (c === ')') { depth--; i++; continue }
    if (depth === 0) {
      const rest = text.slice(i)
      const m = rest.match(re)
      if (m && m.index === 0) { found = { index: i, match: m }; i += m[0].length; continue }
    }
    i++
  }
  return found
}

/** Extract the top-level (depth 0) `alias` a projection item ends in, per every quoting style. */
const TRAILING_AS_RE = /^AS\s+(?:"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))$/i

function splitAlias(item: string): { expr: string; alias: string | null } {
  // Find the LAST top-level ` AS ` — an item can't legally have two, but scanning
  // for the last keeps this robust to a stray earlier match.
  let lastAs: { index: number; match: RegExpMatchArray } | null = null
  let searchFrom = 0
  for (;;) {
    const found = findTopLevel(item.slice(searchFrom), /\bAS\b/i)
    if (!found) break
    lastAs = { index: searchFrom + found.index, match: found.match }
    searchFrom = searchFrom + found.index + found.match[0].length
  }
  if (!lastAs) return { expr: item, alias: null }

  const tail = item.slice(lastAs.index).trim()
  const m = tail.match(TRAILING_AS_RE)
  if (!m) return { expr: item, alias: null }

  const alias = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? null
  const expr = item.slice(0, lastAs.index).trim()
  return { expr, alias }
}

// ── Projection classification ───────────────────────────────────────────────

const DIV_100_RE = /\/\s*100(\.0*)?\b/

/**
 * A `CASE WHEN <condition> THEN ...` condition is a boolean test, not a value
 * the projection outputs — `SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END)`
 * mentions `amount` only to decide between two flag literals, and the result
 * is a count, not a currency figure. Both `containsMoneyColumn` and the /100
 * check operate on this stripped text, not the raw expression, so a money
 * column named only inside a WHEN condition doesn't make an otherwise
 * money-free expression look like money.
 */
function stripCaseConditions(expr: string): string {
  return expr.replace(/\bWHEN\b[\s\S]*?\bTHEN\b/gi, 'WHEN THEN')
}

function containsMoneyColumn(expr: string): boolean {
  const scanned = stripCaseConditions(expr)
  return ALL_MONEY_COLUMN_NAMES.some((name) => new RegExp(`\\b${name}\\b`, 'i').test(scanned))
}

/** Rule (a)'s bare/qualified single-column reference, optionally negated. */
const BARE_COLUMN_RE =
  /^-?\s*(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?$/

function moneyColumnAt(name: string): { table: string; column: string } | null {
  const lower = name.toLowerCase()
  for (const [table, columns] of Object.entries(MONEY_COLUMNS)) {
    const hit = columns.find((c) => c.toLowerCase() === lower)
    if (hit) return { table, column: hit }
  }
  return null
}

/** Whether `expr` resolves to exactly one money column via rule (a)'s allowed wrappers. */
function resolveUnitPreservingMoneyColumn(expr: string): { table: string; column: string } | null {
  const trimmed = expr.trim()

  const bare = trimmed.match(BARE_COLUMN_RE)
  if (bare) {
    const col = moneyColumnAt(bare[2])
    return col
  }

  const agg = trimmed.match(/^(SUM|MIN|MAX|AVG)\s*\(([\s\S]*)\)$/i)
  if (agg) return resolveUnitPreservingMoneyColumn(agg[2])

  const caseMatch = trimmed.match(/^CASE\s+WHEN\s+[\s\S]+?\s+THEN\s+([\s\S]+?)\s+ELSE\s+([\s\S]+?)\s+END$/i)
  if (caseMatch) {
    const branches = [caseMatch[1], caseMatch[2]]
    let resolved: { table: string; column: string } | null = null
    for (const branch of branches) {
      const b = branch.trim()
      if (/^-?\d+(\.\d+)?$/.test(b)) continue // bare numeric literal — unit-neutral
      const col = resolveUnitPreservingMoneyColumn(b)
      if (!col) return null
      if (resolved && (resolved.table !== col.table || resolved.column !== col.column)) return null
      resolved = col
    }
    return resolved
  }

  return null
}

type ItemPlan =
  | { kind: 'not-money' }
  | { kind: 'already-converted' }
  | { kind: 'convert'; key: string }
  | { kind: 'refuse' }

/** Classifies a non-star projection item. `moneyUnitsPlan` handles `*` / `qualifier.*` itself. */
function classifyItem(item: string): ItemPlan {
  const { expr, alias } = splitAlias(item)
  if (!containsMoneyColumn(expr)) return { kind: 'not-money' }
  if (/^\s*COUNT\s*\(/i.test(expr)) return { kind: 'not-money' }
  if (DIV_100_RE.test(stripCaseConditions(expr))) return { kind: 'already-converted' }

  const resolved = resolveUnitPreservingMoneyColumn(expr)
  if (!resolved) return { kind: 'refuse' }

  if (alias) return { kind: 'convert', key: alias }

  // No alias: only safe to name a key for the plain bare/qualified column case,
  // where SQLite's default result key is the column's own name. Anything more
  // complex without an alias can't be reliably matched back to a row key.
  const bare = expr.trim().match(BARE_COLUMN_RE)
  if (bare) return { kind: 'convert', key: bare[2] }

  return { kind: 'refuse' }
}

// ── Public API ───────────────────────────────────────────────────────────────

export type MoneyUnitsPlan =
  | { kind: 'ok'; convertKeys: string[] }
  | { kind: 'refuse' }

/**
 * Decide, from the SQL text alone, which result keys of the final SELECT need
 * dividing by 100 before narration — or that the query's shape can't be
 * resolved and must be refused outright (ADR-0014 `unsupported-shape`).
 */
export function moneyUnitsPlan(sql: string): MoneyUnitsPlan {
  if (/^\s*WITH\b/i.test(sql)) return { kind: 'refuse' } // a CTE — not resolvable, per ADR-0020

  const tableSources = resolveTableSources(sql)

  const fromSplit = findTopLevel(sql, /\bFROM\b/i)
  const selectListText = fromSplit ? sql.slice(0, fromSplit.index) : sql
  const withoutSelect = selectListText.replace(/^\s*SELECT\s+(DISTINCT\s+)?/i, '')
  const items = splitTopLevel(withoutSelect)

  const convertKeys: string[] = []
  for (const item of items) {
    const star = item.match(/^(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?\*$/)
    if (star) {
      const qualifier = star[1]?.toLowerCase()
      const table = qualifier
        ? tableSources.qualifiers.get(qualifier)
        : tableSources.tables.size === 1
          ? [...tableSources.tables][0]
          : undefined
      if (!table) return { kind: 'refuse' }
      const moneyCols = MONEY_COLUMNS[table] ?? []
      convertKeys.push(...moneyCols)
      continue
    }

    const plan = classifyItem(item)
    if (plan.kind === 'refuse') return { kind: 'refuse' }
    if (plan.kind === 'convert') convertKeys.push(plan.key)
  }

  return { kind: 'ok', convertKeys: [...new Set(convertKeys)] }
}

/**
 * Divide the planned keys' values by 100 in every row, returning a new row
 * array. Non-numeric and absent values pass through unchanged — a NULL
 * aggregate on a no-data result stays NULL, it does not become 0.
 */
export function applyMoneyUnits(rows: unknown[], plan: MoneyUnitsPlan): unknown[] {
  if (plan.kind === 'refuse' || plan.convertKeys.length === 0) return rows
  const keys = new Set(plan.convertKeys)
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
    for (const key of keys) {
      const value = out[key]
      if (typeof value === 'number') out[key] = value / 100
    }
    return out
  })
}
