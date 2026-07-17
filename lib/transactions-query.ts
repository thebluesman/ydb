// Shared query/predicate logic for the ledger (Phase 1) — used by both the
// server component (`app/ledger/page.tsx`) and the API route
// (`app/api/transactions/route.ts`) so the two can't drift.
//
// The stats aggregation mirrors the exclusion rules that used to live in the
// `stats` memo of `LedgerView.tsx` (income/expense sums excluding transfers
// and both sides of a matched reimbursement pair). Those rules are subtle, so
// the SQL below is validated against a JS oracle port in
// `tests/ledgerStats.oracle.test.ts` — keep them in lockstep.
//
// NOTE: split legs are hidden from the ledger (rows with a non-null
// parentTransactionId render under their parent), so the whole ledger — page
// rows AND stats — operates over `parentTransactionId IS NULL` only. This is
// deliberately different from the dashboard, which hides split *parents* and
// counts the legs. Do not "fix" one to match the other without updating the
// oracle test.

export const SORT_KEYS = ['date', 'amount', 'description', 'category', 'transactionType'] as const
export type SortKey = (typeof SORT_KEYS)[number]

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

// The 5 relation includes the ledger rows need. Only ever attached to the
// returned page — never to a full-table scan.
export const TRANSACTION_INCLUDE = {
  account: { select: { name: true, currency: true } },
  splitLegs: { select: { id: true, amount: true, category: true, description: true } },
  reimbursementTx: { select: { id: true, amount: true, description: true } },
  reimbursedExpense: { select: { id: true, description: true } },
  transferCounterpartAccount: { select: { id: true, name: true } },
} as const

export type LedgerQuery = {
  page: number
  pageSize: number
  accountId: number | null
  type: string | null
  category: string | null
  status: string | null
  search: string | null
  sort: SortKey
  dir: 'asc' | 'desc'
  pendingReimbursements: boolean
  format: 'json' | 'csv'
  // Inclusive YYYY-MM-DD bounds (Phase U5 ledger date filter). Either/both may
  // be null — an unset bound leaves that side of the range open.
  startDate: string | null
  endDate: string | null
}

// Currency scope resolves the "which accounts count" question so the stat
// cards don't mix currencies (the old bug: sum cents across accounts of
// different currencies, label with the base currency). Mirrors the
// dashboard, which partitions by currency.
export type CurrencyScope = {
  currency: string
  // account ids to constrain to when no explicit account filter is set and
  // more than one currency exists. null = no constraint needed (single
  // currency, or an explicit accountId already narrows it).
  accountIds: number[] | null
}

type AccountLike = { id: number; currency: string }

export function resolveCurrencyScope(
  accounts: AccountLike[],
  accountId: number | null,
  baseCurrency: string,
): CurrencyScope {
  if (accountId != null) {
    const acc = accounts.find((a) => a.id === accountId)
    return { currency: acc?.currency ?? baseCurrency, accountIds: null }
  }
  const currencies = new Set(accounts.map((a) => a.currency))
  if (currencies.size <= 1) {
    // Nothing to disambiguate — every account shares the one currency.
    return { currency: baseCurrency, accountIds: null }
  }
  return {
    currency: baseCurrency,
    accountIds: accounts.filter((a) => a.currency === baseCurrency).map((a) => a.id),
  }
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = value == null ? NaN : parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function parseLedgerQuery(params: URLSearchParams): LedgerQuery {
  const rawSort = params.get('sort')
  const sort: SortKey = (SORT_KEYS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as SortKey)
    : 'date'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const type = normalizeEnum(params.get('type'), ['debit', 'credit', 'transfer'])
  const status = normalizeEnum(params.get('status'), ['committed', 'reconciled', 'review'])
  const accountIdRaw = params.get('accountId')
  const accountId =
    accountIdRaw && accountIdRaw !== 'all' && Number.isFinite(parseInt(accountIdRaw, 10))
      ? parseInt(accountIdRaw, 10)
      : null
  const category = params.get('category')
  const search = params.get('search')?.trim() || null
  const format = params.get('format') === 'csv' ? 'csv' : 'json'

  return {
    page: clampInt(params.get('page'), 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: clampInt(params.get('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    accountId,
    type,
    category: category && category !== 'all' ? category : null,
    status,
    search,
    sort,
    dir,
    pendingReimbursements: params.get('pendingReimbursements') === '1',
    format,
    startDate: parseIsoDateParam(params.get('startDate')),
    endDate: parseIsoDateParam(params.get('endDate')),
  }
}

// A malformed ?startDate=/?endDate= would otherwise turn into a broken SQL
// date-literal comparison — validate the YYYY-MM-DD shape (and that it parses
// to a real date) up front and drop anything else, same fail-open approach
// the dashboard's date parsing already uses.
function parseIsoDateParam(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return isNaN(new Date(value).getTime()) ? null : value
}

function normalizeEnum(value: string | null, allowed: string[]): string | null {
  if (!value || value === 'all') return null
  return allowed.includes(value) ? value : null
}

// ── Raw SQL predicate ────────────────────────────────────────────────────────
// The single filter predicate for the whole ledger. It produces a boolean SQL
// expression (and its positional `?` params) that is the ONE source of truth for
// which transactions the ledger operates over — the page rows, the total count,
// the CSV export, AND the DB-computed stats all build on it, so the row list and
// the stat counts can't drift (they previously did: a Prisma `contains` row
// query treated `%`/`_` in the search term as wildcards while the stats SQL
// escaped them). It is also re-used inside the reimbursement NOT EXISTS subquery
// so the "settlement side" exclusion is scoped to the same filtered set the old
// JS `settled` memo was.
//
// `applyCurrencyScope` gates ONLY the multi-currency "all accounts" narrowing:
// the stats/pending aggregates pass `true` (money math needs a single currency,
// so cross-currency accounts are excluded and the cards labelled with the base
// currency), while the row list / count / CSV pass `false` so "All accounts"
// shows every account's transactions regardless of currency — an explicit
// `accountId` filter still applies in both cases.
//
// `?` placeholders work identically for Prisma `$queryRawUnsafe` and a bare
// better-sqlite3 statement (the oracle test uses the latter).
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function buildFilterSql(
  q: LedgerQuery,
  scope: CurrencyScope,
  alias = 't',
  { applyCurrencyScope = true }: { applyCurrencyScope?: boolean } = {},
): { clause: string; params: unknown[] } {
  const a = `"${alias}"`
  const clauses: string[] = [`${a}."parentTransactionId" IS NULL`]
  const params: unknown[] = []

  if (q.accountId != null) {
    clauses.push(`${a}."accountId" = ?`)
    params.push(q.accountId)
  } else if (applyCurrencyScope && scope.accountIds != null) {
    if (scope.accountIds.length === 0) {
      clauses.push('1 = 0')
    } else {
      clauses.push(`${a}."accountId" IN (${scope.accountIds.map(() => '?').join(', ')})`)
      params.push(...scope.accountIds)
    }
  }
  if (q.type) {
    clauses.push(`${a}."transactionType" = ?`)
    params.push(q.type)
  }
  if (q.category) {
    clauses.push(`${a}."category" = ?`)
    params.push(q.category)
  }
  if (q.status) {
    clauses.push(`${a}."status" = ?`)
    params.push(q.status)
  }
  if (q.pendingReimbursements) {
    clauses.push(`${a}."reimbursableFor" IS NOT NULL AND ${a}."reimbursementTxId" IS NULL`)
  }
  if (q.search) {
    const like = `%${escapeLike(q.search)}%`
    clauses.push(
      `(${a}."description" LIKE ? ESCAPE '\\' OR ${a}."originalDescription" LIKE ? ESCAPE '\\')`,
    )
    params.push(like, like)
  }
  // Inclusive [startDate, endDate] bound (Phase U5 ledger date filter). Dates
  // are compared in UTC — the same convention transactions are stored and
  // bucketed in elsewhere in this file (see toDbDate) — so a `2026-07-01`
  // bound always means "from the start of that UTC calendar day".
  if (q.startDate) {
    clauses.push(`${a}."date" >= ?`)
    params.push(toDbDate(new Date(`${q.startDate}T00:00:00.000Z`)))
  }
  if (q.endDate) {
    clauses.push(`${a}."date" <= ?`)
    params.push(toDbDate(new Date(`${q.endDate}T23:59:59.999Z`)))
  }

  return { clause: clauses.join(' AND '), params }
}

// Shared ORDER BY. `sort` is whitelisted to SORT_KEYS (all real columns) and
// `dir` normalised to asc/desc in parseLedgerQuery, so this interpolation is
// not injectable. The `id` tiebreaker keeps pagination deterministic when the
// sort column has ties (same-day dates, equal amounts, …).
function orderBySql(q: LedgerQuery, alias = 't'): string {
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC'
  return `ORDER BY "${alias}"."${q.sort}" ${dir}, "${alias}"."id" ASC`
}

// Page of row ids for the current filter/sort, honouring pagination. Rows are
// selected by id here (via the shared predicate, so the LIKE/ESCAPE semantics
// match the stats) and hydrated with their relations by a follow-up Prisma
// findMany keyed on these ids. Not currency-scoped — see buildFilterSql.
export function buildPageIdsSql(q: LedgerQuery, scope: CurrencyScope): { sql: string; params: unknown[] } {
  const { clause, params } = buildFilterSql(q, scope, 't', { applyCurrencyScope: false })
  const sql = `
    SELECT "t"."id" AS id
    FROM "Transaction" "t"
    WHERE ${clause}
    ${orderBySql(q)}
    LIMIT ? OFFSET ?
  `
  return { sql, params: [...params, q.pageSize, (q.page - 1) * q.pageSize] }
}

// Total rows matching the filter (drives pagination). Same predicate as the
// page, so the count and the visible rows agree.
export function buildCountSql(q: LedgerQuery, scope: CurrencyScope): { sql: string; params: unknown[] } {
  const { clause, params } = buildFilterSql(q, scope, 't', { applyCurrencyScope: false })
  return { sql: `SELECT COUNT(*) AS count FROM "Transaction" "t" WHERE ${clause}`, params }
}

// Full filtered set of ids in sort order (no pagination) — for CSV export.
export function buildExportIdsSql(q: LedgerQuery, scope: CurrencyScope): { sql: string; params: unknown[] } {
  const { clause, params } = buildFilterSql(q, scope, 't', { applyCurrencyScope: false })
  return {
    sql: `SELECT "t"."id" AS id FROM "Transaction" "t" WHERE ${clause} ${orderBySql(q)}`,
    params,
  }
}

export type LedgerStats = {
  income: number
  expenses: number
  net: number
  incomeCount: number
  expenseCount: number
}

// Stats SQL, mirroring the old `stats` memo:
//   - operate over the filtered set (parentTransactionId IS NULL implied by P)
//   - exclude transfers
//   - exclude the expense side of a matched reimbursement pair (reimbursementTxId set)
//   - exclude the settlement side (some filtered row points its reimbursementTxId here)
// income/expenses sum ABS(amount) by declared transactionType.
export function buildStatsSql(q: LedgerQuery, scope: CurrencyScope): { sql: string; params: unknown[] } {
  const outer = buildFilterSql(q, scope, 't')
  const inner = buildFilterSql(q, scope, 's')
  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN "t"."transactionType" = 'credit' THEN ABS("t"."amount") ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN "t"."transactionType" = 'debit'  THEN ABS("t"."amount") ELSE 0 END), 0) AS expenses,
      COALESCE(SUM(CASE WHEN "t"."transactionType" = 'credit' THEN 1 ELSE 0 END), 0) AS incomeCount,
      COALESCE(SUM(CASE WHEN "t"."transactionType" = 'debit'  THEN 1 ELSE 0 END), 0) AS expenseCount
    FROM "Transaction" "t"
    WHERE ${outer.clause}
      AND "t"."transactionType" != 'transfer'
      AND "t"."reimbursementTxId" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "Transaction" "s"
        WHERE ${inner.clause} AND "s"."reimbursementTxId" = "t"."id"
      )
  `
  return { sql, params: [...outer.params, ...inner.params] }
}

// Pending-reimbursements summary for the banner. Currency-scoped (so the
// outstanding total isn't a cross-currency sum) but deliberately independent
// of the active type/category/status/search filters — the banner reflects the
// account/currency context, matching the old always-visible behaviour.
export function buildPendingSql(scope: CurrencyScope, accountId: number | null): { sql: string; params: unknown[] } {
  const clauses: string[] = [
    `"parentTransactionId" IS NULL`,
    `"reimbursableFor" IS NOT NULL`,
    `"reimbursementTxId" IS NULL`,
  ]
  const params: unknown[] = []
  if (accountId != null) {
    clauses.push(`"accountId" = ?`)
    params.push(accountId)
  } else if (scope.accountIds != null) {
    if (scope.accountIds.length === 0) {
      clauses.push('1 = 0')
    } else {
      clauses.push(`"accountId" IN (${scope.accountIds.map(() => '?').join(', ')})`)
      params.push(...scope.accountIds)
    }
  }
  const sql = `
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(ABS("amount")), 0) AS outstanding
    FROM "Transaction"
    WHERE ${clauses.join(' AND ')}
  `
  return { sql, params }
}

// Coerce a raw-SQL numeric aggregate (better-sqlite3 may hand back a
// number/bigint/string depending on driver + magnitude) to a JS number.
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared transaction-aggregation SQL (Dashboard — Phase 2).
//
// This module is the single source of truth for the "hidden rows" exclusion
// rules that both the Dashboard (app/dashboard/page.tsx) and the ledger stat
// cards depend on. Historically each screen re-implemented the rules in an
// in-memory JS pass over every committed transaction; that both scaled badly
// and let the two screens silently drift. The rules are:
//
//   1. A split parent is a placeholder that summarises its legs. When legs
//      exist, the legs carry the real (granular) categories, so the PARENT is
//      hidden and the legs are counted.
//   2. Both sides of a matched reimbursement pair net to zero. The expense side
//      carries `reimbursementTxId` (the settlement row's id); the settlement
//      side is the row that id points at. Leaving either in inflates income and
//      expenses equally, so BOTH are hidden.
//   3. Transfers are movements between the user's own accounts and are excluded
//      from income/expense figures (handled by the callers' WHERE clauses, not
//      here — the inclusion predicate below is type-agnostic so it can also be
//      used for the raw-balance pre-range seed which DOES include transfers).
//
// The predicate is emitted as a fully-inlined SQL string (no bound params) so
// the *exact same* SQL text runs under Prisma `$queryRawUnsafe` in the app and
// under a plain better-sqlite3 connection in tests/dashboard.oracle.test.ts.
// Only non-user-controlled values are ever inlined: account ids (integers from
// the DB) and ISO date literals we format ourselves — never free-form strings.
//
// Month bucketing uses strftime(..., 'localtime') deliberately: the DB stores
// dates as UTC ISO strings (e.g. 2024-03-15T00:00:00.000+00:00) but the
// previous JS aggregation bucketed months with Date.getMonth() in the server's
// LOCAL timezone. 'localtime' reproduces that exactly (verified against a
// non-UTC TZ), so a home server keeps identical month boundaries after the
// rewrite.
// ─────────────────────────────────────────────────────────────────────────────

const COMMITTED_STATUSES = "('committed','reconciled')"

/** Format a Date as the exact UTC ISO string SQLite stores, so lexicographic
 *  string comparison against stored `date` values is order-preserving. */
export function toDbDate(d: Date): string {
  // Prisma's SQLite adapter stores "…+00:00", not "…Z"; matching that suffix
  // keeps `date < 'literal'` comparisons exact at instant boundaries.
  return d.toISOString().replace('Z', '+00:00')
}

function assertIntIds(ids: number[]): void {
  for (const id of ids) {
    if (!Number.isInteger(id)) throw new Error(`account id must be an integer, got ${id}`)
  }
}

/** The base row filter shared by the outer query and the EXISTS subqueries.
 *  `alias.accountId IN (…) AND alias.status IN (…) [AND alias.date < '…']`.
 *  An empty id list yields a predicate that matches no rows. */
function scopeSql(alias: string, accountIds: number[], dateLtIso?: string): string {
  assertIntIds(accountIds)
  const idList = accountIds.length > 0 ? accountIds.join(',') : '-1'
  let s = `${alias}.accountId IN (${idList}) AND ${alias}.status IN ${COMMITTED_STATUSES}`
  if (dateLtIso) s += ` AND ${alias}.date < '${dateLtIso}'`
  return s
}

/**
 * SQL predicate that is TRUE for rows to KEEP (i.e. not hidden). Excludes split
 * parents that have legs and both sides of matched reimbursement pairs. The
 * EXISTS subqueries are scoped to the same base filter as the outer query so
 * the result matches the old JS `hiddenTxIds` set exactly.
 *
 * `INDEXED BY` on both correlated subqueries (Phase 8 seed-script finding):
 * without a hint, SQLite's planner sometimes picks
 * `Transaction_accountId_date_idx` for these subqueries — a fine choice on
 * its own, but disastrous here because it's a *range* scan (`accountId=? AND
 * date<?`) re-run per outer row instead of the equality lookup on
 * `parentTransactionId`/`reimbursementTxId` (at most one match, guaranteed by
 * the `@unique` constraint on reimbursementTxId). Confirmed via
 * `npm run seed` (~48k rows) + `EXPLAIN QUERY PLAN`: the pre-range net-worth
 * queries (which add a `dateLtIso` bound here) went from ~52 SECONDS to
 * ~40ms with these hints — a real, reproducible regression, not a
 * theoretical one. `parentTransactionId`/`reimbursementTxId` equality is
 * always by far the most selective predicate available (a transaction has at
 * most one split parent and one reimbursement settlement), so forcing it is
 * safe regardless of how many account ids or how wide the date range is.
 *
 * @param mainAlias alias of the outer row (e.g. "main")
 * @param accountIds accounts in scope
 * @param dateLtIso  optional `date < ISO` upper bound applied to the scope
 */
export function inclusionSql(mainAlias: string, accountIds: number[], dateLtIso?: string): string {
  const child = scopeSql('c', accountIds, dateLtIso)
  const reimb = scopeSql('r', accountIds, dateLtIso)
  return (
    `${mainAlias}.reimbursementTxId IS NULL` +
    ` AND NOT EXISTS (SELECT 1 FROM "Transaction" c INDEXED BY "Transaction_parentTransactionId_idx" WHERE c.parentTransactionId = ${mainAlias}.id AND ${child})` +
    ` AND NOT EXISTS (SELECT 1 FROM "Transaction" r INDEXED BY "Transaction_reimbursementTxId_key" WHERE r.reimbursementTxId = ${mainAlias}.id AND ${reimb})`
  )
}

// ── Aggregation query builders ───────────────────────────────────────────────
// Each returns a fully-formed SQL string. `accountIds` are inlined integers;
// date bounds are inlined ISO literals via toDbDate. Results are grouped/summed
// entirely in SQLite so no full-table read reaches the application.

export type MonthlyRow = { ym: string; income: number; expenses: number; cnt: number }
export type CategoryRow = { category: string; total: number; cnt: number }
export type TrendRow = { ym: string; category: string; total: number }

/** Monthly income/expense sums + non-transfer row count, within [start,end]. */
export function monthlySql(accountIds: number[], startIso: string, endIso: string): string {
  const scope = scopeSql('main', accountIds)
  const incl = inclusionSql('main', accountIds)
  return (
    `SELECT strftime('%Y-%m', date, 'localtime') AS ym,` +
    ` SUM(CASE WHEN transactionType = 'credit' THEN ABS(amount) ELSE 0 END) AS income,` +
    ` SUM(CASE WHEN transactionType = 'debit'  THEN ABS(amount) ELSE 0 END) AS expenses,` +
    ` COUNT(*) AS cnt` +
    ` FROM "Transaction" main` +
    ` WHERE ${scope} AND main.transactionType != 'transfer'` +
    ` AND main.date >= '${startIso}' AND main.date <= '${endIso}'` +
    ` AND ${incl}` +
    ` GROUP BY ym`
  )
}

/** Debit (expense) totals + counts per category, within [start,end]. */
export function categorySql(accountIds: number[], startIso: string, endIso: string): string {
  const scope = scopeSql('main', accountIds)
  const incl = inclusionSql('main', accountIds)
  return (
    `SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS cnt` +
    ` FROM "Transaction" main` +
    ` WHERE ${scope} AND main.transactionType = 'debit'` +
    ` AND main.date >= '${startIso}' AND main.date <= '${endIso}'` +
    ` AND ${incl}` +
    ` GROUP BY category ORDER BY total DESC`
  )
}

/** Debit totals per (month, category) for the stacked trend chart. */
export function categoryTrendSql(accountIds: number[], startIso: string, endIso: string): string {
  const scope = scopeSql('main', accountIds)
  const incl = inclusionSql('main', accountIds)
  return (
    `SELECT strftime('%Y-%m', date, 'localtime') AS ym, category, SUM(ABS(amount)) AS total` +
    ` FROM "Transaction" main` +
    ` WHERE ${scope} AND main.transactionType = 'debit'` +
    ` AND main.date >= '${startIso}' AND main.date <= '${endIso}'` +
    ` AND ${incl}` +
    ` GROUP BY ym, category`
  )
}

// ── Net-worth history (Phase 7 item 4) ──────────────────────────────────────
// Computes a monthly net-worth series as: per-account opening balance +
// cumulative signed transaction sums, grouped in ONE query per data need
// (pre-range seed, and in-range monthly deltas), then combined in
// app/dashboard/page.tsx via lib/accounts.ts computeBalance (which applies
// the asset/liability sign rule) and summed across accounts per month. This
// mirrors the *current* per-account balance computation (`sumByAccount`
// above — a plain groupBy sum over committed+reconciled rows, no
// split/reimbursement exclusion) rather than the income-statement
// `inclusionSql` used for cash-flow/category aggregates, so the last point
// of the history reconciles with the account balances shown elsewhere on
// the same dashboard.

export type AccountMonthlyRow = { accountId: number; ym: string; s: number }
export type AccountSumRow = { accountId: number; s: number }

/** Per-account, per-month signed transaction sum within [start,end]. */
export function accountMonthlySumSql(accountIds: number[], startIso: string, endIso: string): string {
  const scope = scopeSql('main', accountIds)
  return (
    `SELECT accountId, strftime('%Y-%m', date, 'localtime') AS ym, SUM(amount) AS s` +
    ` FROM "Transaction" main` +
    ` WHERE ${scope} AND main.date >= '${startIso}' AND main.date <= '${endIso}'` +
    ` GROUP BY accountId, ym`
  )
}

/** Per-account signed transaction sum strictly before `startIso` — the seed
 *  each account's running balance starts from when walking the in-range
 *  months. */
export function preRangeSumByAccountSql(accountIds: number[], startIso: string): string {
  const scope = scopeSql('main', accountIds, startIso)
  return (
    `SELECT accountId, COALESCE(SUM(amount), 0) AS s` +
    ` FROM "Transaction" main` +
    ` WHERE ${scope}` +
    ` GROUP BY accountId`
  )
}

/** Raw (signed) balance of asset accounts strictly before `startIso`, used to
 *  seed the cash-flow opening row. Includes all types (transfers too); only the
 *  hidden-rows exclusion applies. */
export function preRangeAssetSumSql(assetAccountIds: number[], startIso: string): string {
  const scope = scopeSql('main', assetAccountIds, startIso)
  const incl = inclusionSql('main', assetAccountIds, startIso)
  return (
    `SELECT COALESCE(SUM(amount), 0) AS s` +
    ` FROM "Transaction" main` +
    ` WHERE ${scope} AND ${incl}`
  )
}
