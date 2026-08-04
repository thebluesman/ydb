/**
 * Server-side money-column PRESENTATION for the chat SQL path (ADR-0020,
 * ADR-0027).
 *
 * Two presentation properties of a money value are decided here, from the SQL
 * text alone, and never by the model: its UNITS (ADR-0020 — cents or currency,
 * documented immediately below) and its DISPLAY SIGN (ADR-0027 — whether a
 * figure whose direction the query already pinned should read as a magnitude,
 * documented at `magnitudeKeys` further down). They share this module rather
 * than living in two because both answers come from walking the same final
 * SELECT, resolving the same schema money columns through the same qualifier
 * and star-expansion logic; a second copy of that machinery is how
 * `lib/chatAccountVocabulary.ts`'s resolver bug would have been reproduced
 * instead of inherited-fixed.
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

type TopLevelHit = { index: number; match: RegExpMatchArray }

/** Every top-level (depth 0, outside quotes) occurrence of `re`, in order. */
function findAllTopLevel(text: string, re: RegExp): TopLevelHit[] {
  let depth = 0
  let i = 0
  const found: TopLevelHit[] = []
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
      if (m && m.index === 0) { found.push({ index: i, match: m }); i += m[0].length; continue }
    }
    i++
  }
  return found
}

/**
 * The LAST top-level occurrence of `re`, or null. Last rather than first is
 * what `splitAlias` below wants; callers that need the first (the WHERE clause
 * scan) use `findAllTopLevel` directly.
 */
function findTopLevel(text: string, re: RegExp): TopLevelHit | null {
  const all = findAllTopLevel(text, re)
  return all.length > 0 ? all[all.length - 1] : null
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

type MoneyColumnRef = { table: string; column: string }

const AGGREGATE_RE = /^(SUM|MIN|MAX|AVG)\s*\(([\s\S]*)\)$/i
const CASE_RE = /^CASE\s+WHEN\s+[\s\S]+?\s+THEN\s+([\s\S]+?)\s+ELSE\s+([\s\S]+?)\s+END$/i
const NUMERIC_LITERAL_RE = /^-?\d+(\.\d+)?$/

/** Whether `expr` resolves to exactly one money column via rule (a)'s allowed wrappers. */
function resolveUnitPreservingMoneyColumn(expr: string): MoneyColumnRef | null {
  const trimmed = expr.trim()

  const bare = trimmed.match(BARE_COLUMN_RE)
  if (bare) {
    const col = moneyColumnAt(bare[2])
    return col
  }

  const agg = trimmed.match(AGGREGATE_RE)
  if (agg) return resolveUnitPreservingMoneyColumn(agg[2])

  const caseMatch = trimmed.match(CASE_RE)
  if (caseMatch) {
    const branches = [caseMatch[1], caseMatch[2]]
    let resolved: { table: string; column: string } | null = null
    for (const branch of branches) {
      const b = branch.trim()
      if (NUMERIC_LITERAL_RE.test(b)) continue // bare numeric literal — unit-neutral
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

// ── Display presentation: money membership and sign (ADR-0027) ──────────────

/**
 * Strip ONE top-level `/ 100` or `/ 100.0` divisor, so the remainder can go
 * through the same `resolveUnitPreservingMoneyColumn` an unconverted
 * projection does. This is what makes `SUM(amount) / 100.0 AS total` and
 * `SUM(amount) AS total` land on the same money column — ADR-0020's classifier
 * stops at "already converted" and never resolves the former, which is exactly
 * why `convertKeys` was undercounting the frame's money set.
 *
 * One divisor, not all of them: `SUM(...) / 100.0 / 6` is an average whose
 * remaining `/ 6` no longer resolves, and it lands on plain `number` rather
 * than being talked into a money column. Under-detection here costs a missing
 * currency symbol, which is the direction ADR-0027 fails in.
 */
const TOP_LEVEL_DIV_100_RE = /^\/\s*100(\.0*)?(?![0-9.])/

function stripOneDiv100(expr: string): string {
  const hits = findAllTopLevel(expr, TOP_LEVEL_DIV_100_RE)
  if (hits.length === 0) return expr
  const hit = hits[0]
  return (expr.slice(0, hit.index) + expr.slice(hit.index + hit.match[0].length)).trim()
}

/**
 * Whether the projection itself flips its money column's sign: `-amount`,
 * `SUM(-amount)`, or a CASE whose value branches are all `-amount` or numeric
 * literals. Mirrors `resolveUnitPreservingMoneyColumn`'s recursion shape so
 * the two agree about which expressions they understand at all.
 *
 * `-SUM(amount)` is deliberately not recognised: `resolveUnitPreservingMoneyColumn`
 * doesn't resolve it either, so it never reaches `moneyKeys` and there is
 * nothing for this to decide about.
 */
function negatesMoneyColumn(expr: string): boolean {
  const trimmed = expr.trim()

  const bare = trimmed.match(BARE_COLUMN_RE)
  if (bare) return trimmed.startsWith('-') && moneyColumnAt(bare[2]) !== null

  const agg = trimmed.match(AGGREGATE_RE)
  if (agg) return negatesMoneyColumn(agg[2])

  const caseMatch = trimmed.match(CASE_RE)
  if (caseMatch) {
    let negated = false
    for (const branch of [caseMatch[1], caseMatch[2]]) {
      const b = branch.trim()
      if (NUMERIC_LITERAL_RE.test(b)) continue // a 0/1 branch carries no direction
      if (!negatesMoneyColumn(b)) return false
      negated = true
    }
    return negated
  }

  return false
}

/** `table.column`, lowercased — the key both pin detection and lookup use. */
function moneyColumnKey(ref: MoneyColumnRef): string {
  return `${ref.table}.${ref.column.toLowerCase()}`
}

const CLAUSE_AFTER_WHERE_RE = /^(?:GROUP\s+BY|ORDER\s+BY|HAVING|WINDOW|LIMIT|OFFSET)\b/i

/** `amount < 0`, `t.amount >= 0`, … — a comparison against zero that fixes a direction. */
const DIRECTION_PIN_RE =
  /^(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:<=|>=|<|>)\s*0(?:\.0*)?(?![0-9.])/

/**
 * Money columns whose direction the statement's own top-level WHERE already
 * pinned. `WHERE amount < 0` means every row that survives is an outflow, so
 * the minus sign in front of the result carries no information the filter
 * hasn't already spent.
 *
 * Scoped to the top-level WHERE at depth 0 on purpose: a comparison inside a
 * subquery (`NOT EXISTS (SELECT 1 … WHERE x.amount < 0)`) restricts that
 * subquery, not this statement's rows, and a pin found there would be a wrong
 * one. Parenthesised top-level conditions are missed for the same reason —
 * under-detection lands on signed display, which is today's behaviour.
 */
function directionPinnedColumns(sql: string, sources: TableSources): Set<string> {
  const pinned = new Set<string>()

  // `findAllTopLevel` tests its pattern at every depth-0 offset, including
  // offsets inside an identifier — a leading `\b` can't see the character
  // before the slice it's given. So every scan below drops a hit whose
  // preceding character would have made it part of a longer name
  // (`SOMEWHERE`, or the `amount` inside `t.amount`).
  const startsWord = (text: string, index: number): boolean => {
    const prev = index > 0 ? text[index - 1] : ''
    return !prev || !/[A-Za-z0-9_."]/.test(prev)
  }

  const wheres = findAllTopLevel(sql, /^WHERE\b/i).filter((h) => startsWord(sql, h.index))
  if (wheres.length === 0) return pinned
  const where = wheres[0]

  const after = sql.slice(where.index + where.match[0].length)
  const ends = findAllTopLevel(after, CLAUSE_AFTER_WHERE_RE).filter((h) => startsWord(after, h.index))
  const clause = ends.length > 0 ? after.slice(0, ends[0].index) : after

  // A direction predicate joined by a top-level OR does not pin anything:
  // `amount < 0 OR category = 'Refunds'` is satisfied by positive rows too,
  // so treating that clause as pinning direction would strip a real sign off
  // a real net rather than just miss a display upgrade. Bail out on any
  // depth-0 OR rather than try to reason about which side of it a hit
  // belongs to — a parenthesised `(amount < 0 OR ...)` is unaffected since it
  // sits at depth >= 1 and `findAllTopLevel` never looks inside it.
  if (findAllTopLevel(clause, /^OR\b/i).some((h) => startsWord(clause, h.index))) {
    return pinned
  }

  for (const hit of findAllTopLevel(clause, DIRECTION_PIN_RE)) {
    if (!startsWord(clause, hit.index)) continue

    const [, qualifier, name] = hit.match
    const col = moneyColumnAt(name)
    if (!col) continue

    const table = qualifier ? sources.qualifiers.get(qualifier.toLowerCase()) : col.table
    if (!table || table !== col.table) continue

    pinned.add(moneyColumnKey(col))
  }

  return pinned
}

// ── Public API ───────────────────────────────────────────────────────────────

export type MoneyUnitsPlan =
  | {
      kind: 'ok'
      /** ADR-0020: keys still in raw cents, which `applyMoneyUnits` divides by 100. */
      convertKeys: string[]
      /**
       * ADR-0027: every key whose projection item resolves to exactly one money
       * column, converted or not. This — not `convertKeys` — is what makes a
       * column `kind: 'money'` in the `result` frame. A derived ratio that only
       * mentions `amount` doesn't resolve and stays out, which keeps ADR-0020's
       * documented ratio blind spot from putting a currency symbol on a
       * non-currency figure.
       */
      moneyKeys: string[]
      /**
       * ADR-0027, ⊆ `moneyKeys`: keys whose direction the query already fixed,
       * so their sign carries no information and display shows `|value|`.
       * Everything else stays signed with no exception — a bare
       * `SUM(amount) AS net` is the deferred signed-answer case and needs no
       * handling because it never enters this set, and a mixed transaction
       * list's per-row sign IS its direction.
       */
      magnitudeKeys: string[]
    }
  | { kind: 'refuse' }

/**
 * The result key a projection item lands on, or null when it can't be named
 * reliably. Deliberately the same derivation `classifyItem` uses — an alias
 * when there is one, otherwise only the plain bare/qualified column case,
 * where SQLite's default result key is the column's own name.
 */
function displayKeyOf(expr: string, alias: string | null): string | null {
  if (alias) return alias
  const bare = expr.trim().match(BARE_COLUMN_RE)
  return bare ? bare[2] : null
}

/**
 * ADR-0027's per-item display decision, independent of ADR-0020's convert
 * decision: does this item resolve to a money column at all (after one `/100`
 * is set aside), and if so, has its direction already been fixed — by the
 * projection negating the column, or by the WHERE pinning it?
 */
function classifyDisplay(
  item: string,
  pinned: Set<string>,
): { key: string; magnitude: boolean } | null {
  const { expr, alias } = splitAlias(item)
  if (!containsMoneyColumn(expr)) return null
  if (/^\s*COUNT\s*\(/i.test(expr)) return null

  const key = displayKeyOf(expr, alias)
  if (!key) return null

  const valueExpr = stripOneDiv100(expr)
  const resolved = resolveUnitPreservingMoneyColumn(valueExpr)
  if (!resolved) return null

  const magnitude = negatesMoneyColumn(valueExpr) || pinned.has(moneyColumnKey(resolved))
  return { key, magnitude }
}

/**
 * Decide, from the SQL text alone, how the final SELECT's money columns are
 * presented: which result keys still need dividing by 100 before narration
 * (ADR-0020), which keys are money at all and which of those display as a
 * magnitude (ADR-0027) — or that the query's shape can't be resolved and must
 * be refused outright (ADR-0014 `unsupported-shape`).
 *
 * The refusal is ADR-0020's and stays units-only: an unresolved *unit*
 * manufactures a 100x error, an unresolved *direction* costs a minus sign in
 * front of a correct number. So the display fields fail open — a shape they
 * can't read simply produces no entry, which lands on signed display, today's
 * behaviour.
 */
export function moneyUnitsPlan(sql: string): MoneyUnitsPlan {
  if (/^\s*WITH\b/i.test(sql)) return { kind: 'refuse' } // a CTE — not resolvable, per ADR-0020

  const tableSources = resolveTableSources(sql)

  const fromSplit = findTopLevel(sql, /\bFROM\b/i)
  const selectListText = fromSplit ? sql.slice(0, fromSplit.index) : sql
  const withoutSelect = selectListText.replace(/^\s*SELECT\s+(DISTINCT\s+)?/i, '')
  const items = splitTopLevel(withoutSelect)

  const pinned = directionPinnedColumns(sql, tableSources)

  const convertKeys: string[] = []
  const moneyKeys: string[] = []
  const magnitudeKeys: string[] = []

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
      // A star's expanded columns are money and carry no projection of their
      // own to negate, so the WHERE pin is their only route to magnitude — a
      // `SELECT * … WHERE amount < 0` list is all outflows and its signs are
      // uniform, while an unfiltered one is mixed and keeps them.
      moneyKeys.push(...moneyCols)
      for (const column of moneyCols) {
        if (pinned.has(moneyColumnKey({ table, column }))) magnitudeKeys.push(column)
      }
      continue
    }

    const plan = classifyItem(item)
    if (plan.kind === 'refuse') return { kind: 'refuse' }
    if (plan.kind === 'convert') convertKeys.push(plan.key)

    const display = classifyDisplay(item, pinned)
    if (display) {
      moneyKeys.push(display.key)
      if (display.magnitude) magnitudeKeys.push(display.key)
    }
  }

  return {
    kind: 'ok',
    convertKeys: [...new Set(convertKeys)],
    moneyKeys: [...new Set(moneyKeys)],
    magnitudeKeys: [...new Set(magnitudeKeys)],
  }
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

/**
 * ADR-0027, mirroring `applyMoneyUnits`: replace every `magnitudeKeys` value
 * with its absolute value, returning a new row array. Numbers only; NULL and
 * absent values pass through untouched, same as above.
 *
 * Unlike `applyMoneyUnits` this runs LATE — after the verifier and after
 * `signPromiseViolation`. A unit is a property of the stored column, so
 * converting it early makes every downstream consumer correct; a sign here is
 * a presentation choice, and every check that reasons about the query's own
 * arithmetic has to see what the SQL actually computed, not what the server
 * decided to show.
 */
export function applyMoneySign(rows: unknown[], plan: MoneyUnitsPlan): unknown[] {
  if (plan.kind === 'refuse' || plan.magnitudeKeys.length === 0) return rows
  const keys = new Set(plan.magnitudeKeys)
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
    for (const key of keys) {
      const value = out[key]
      if (typeof value === 'number') out[key] = Math.abs(value)
    }
    return out
  })
}
