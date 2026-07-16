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
  }
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
