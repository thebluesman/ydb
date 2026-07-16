import { prisma } from '@/lib/prisma'
import { DashboardView } from './_components/DashboardView'
import { computeBalance, isAsset } from '@/lib/accounts'
import {
  toDbDate,
  monthlySql,
  categorySql,
  categoryTrendSql,
  preRangeAssetSumSql,
  type MonthlyRow,
  type CategoryRow,
  type TrendRow,
} from '@/lib/transactions-query'

// Raw SQLite integer aggregates can come back as bigint via the driver; coerce
// to number (cents stay well within 2^53 for any realistic single-user DB).
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number) ?? 0)

export const metadata = { title: 'Dashboard — ydb' }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function monthLabel(key: string) {
  const [y, mo] = key.split('-').map(Number)
  return `${MONTH_NAMES[mo - 1]} ${String(y).slice(-2)}`
}

export type AccountBalance = {
  id: number
  name: string
  accountType: string
  currency: string
  openingBalance: number
  openingBalanceDate: string | null
  currentBalance: number
  creditLimit: number | null
}

export type CashFlowRow = {
  period: string
  openingBalance: number
  income: number
  expenses: number
  closingBalance: number
}

export type TopTransaction = {
  id: number
  date: string
  description: string
  amount: number
  category: string
  accountName: string
}

export type TrendCategory = { name: string; color: string }
export type BudgetData = { category: string; budget: number; actual: number }

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ currency?: string; startDate?: string; endDate?: string }>
}) {
  const params = await searchParams
  const now = new Date()

  // ── Resolve selected currency ──────────────────────────────────────────────
  const [allAccounts, baseCurrencySetting, budgets] = await Promise.all([
    prisma.account.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }),
    prisma.setting.findFirst({ where: { key: 'baseCurrency' } }),
    prisma.budget.findMany({ orderBy: { category: 'asc' } }),
  ])

  const availableCurrencies = [...new Set(allAccounts.map((a) => a.currency))]
  const defaultCurrency =
    baseCurrencySetting?.value ?? allAccounts[0]?.currency ?? 'GBP'
  const selectedCurrency = params.currency ?? defaultCurrency

  const accountsForCurrency = allAccounts.filter((a) => a.currency === selectedCurrency)
  const accountIds = accountsForCurrency.map((a) => a.id)

  // ── Resolve date range ─────────────────────────────────────────────────────
  const defaultStartDate = new Date(now.getFullYear(), now.getMonth() - 11, 1)
  const parsedEndDate = params.endDate ? new Date(params.endDate) : now
  const parsedStartDate = params.startDate ? new Date(params.startDate) : defaultStartDate
  // A malformed ?startDate=/?endDate= produces an Invalid Date; toDbDate()'s
  // toISOString() throws RangeError on those, so fall back to the defaults
  // instead of 500ing the page.
  const endDate = isNaN(parsedEndDate.getTime()) ? now : parsedEndDate
  const startDate = isNaN(parsedStartDate.getTime()) ? defaultStartDate : parsedStartDate

  // Always clamp endDate to end-of-day so the inclusive upper bound covers
  // every transaction on the chosen end date (picker gives start-of-day).
  endDate.setHours(23, 59, 59, 999)

  // ── Aggregate in SQL ───────────────────────────────────────────────────────
  // The split-parent / matched-reimbursement / transfer exclusion rules that
  // used to run as ~6 full in-memory passes over every committed transaction
  // now run as grouped SQLite queries. The exclusion predicate lives once in
  // lib/transactions-query.ts (inclusionSql) so this screen and the ledger
  // stat cards can't drift; tests/dashboard.oracle.test.ts asserts the SQL is
  // equivalent to the previous JS aggregation on a splits/reimbursements/
  // transfers/multi-currency fixture.
  const startIso = toDbDate(startDate)
  const endIso = toDbDate(endDate)

  const [monthlyRows, categoryRows, trendRows] = accountIds.length === 0
    ? [[], [], []] as [MonthlyRow[], CategoryRow[], TrendRow[]]
    : await Promise.all([
        prisma.$queryRawUnsafe<MonthlyRow[]>(monthlySql(accountIds, startIso, endIso)),
        prisma.$queryRawUnsafe<CategoryRow[]>(categorySql(accountIds, startIso, endIso)),
        prisma.$queryRawUnsafe<TrendRow[]>(categoryTrendSql(accountIds, startIso, endIso)),
      ])

  // ── Category breakdown (expenses only, in date range) ──────────────────────
  // SQL already orders by total DESC. rangeCatMap (used by budgets below) is
  // the same debit-in-range spend keyed by category.
  const categoryBreakdown = categoryRows.map((r) => ({
    category: r.category,
    total: num(r.total),
    count: num(r.cnt),
  }))
  const rangeCatMap = new Map(categoryBreakdown.map((c) => [c.category, c.total]))

  // ── Monthly data (in date range, exclude Transfer) ─────────────────────────
  // Seed every month in [start, end] so empty months render as zeroes, then
  // fill from the grouped SQL result.
  const monthMap = new Map<string, { income: number; expenses: number }>()
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
  while (cur <= endDate) {
    monthMap.set(monthKey(cur), { income: 0, expenses: 0 })
    cur.setMonth(cur.getMonth() + 1)
  }
  let totalIncome = 0, totalExpenses = 0, txCount = 0
  for (const r of monthlyRows) {
    const income = num(r.income), expenses = num(r.expenses), cnt = num(r.cnt)
    totalIncome += income; totalExpenses += expenses; txCount += cnt
    const m = monthMap.get(r.ym)
    if (m) { m.income += income; m.expenses += expenses }
  }
  const monthlyData = Array.from(monthMap.entries()).map(([key, { income, expenses }]) => ({
    month: monthLabel(key),
    income,
    expenses,
    net: income - expenses,
  }))

  // ── Summary stats (in date range, exclude Transfer) ─────────────────────────
  // Derived from the monthly aggregate (income/expenses classified by
  // transactionType so Dashboard totals match the Ledger on the same filter).
  const summaryStats = { totalIncome, totalExpenses, net: totalIncome - totalExpenses, txCount }

  // ── Account balances ────────────────────────────────────────────────────────
  // Liability accounts flip the sign (see lib/accounts.ts): debt goes up when
  // the user spends on the card (stored as −X) and down when they pay into it
  // (stored as +X on the card statement).
  // One groupBy instead of one aggregate per account — cuts N+1 at scale.
  const sumRows = await prisma.transaction.groupBy({
    by: ['accountId'],
    where: { accountId: { in: accountIds }, status: { in: ['committed', 'reconciled'] } },
    _sum: { amount: true },
  })
  const sumByAccount = new Map(sumRows.map((r) => [r.accountId, r._sum.amount ?? 0]))
  const accountBalances: AccountBalance[] = accountsForCurrency.map((acc) => {
    const currentBalance = computeBalance(acc, sumByAccount.get(acc.id) ?? 0)
    return {
      id: acc.id,
      name: acc.name,
      accountType: acc.accountType,
      currency: acc.currency,
      openingBalance: acc.openingBalance,
      openingBalanceDate: acc.openingBalanceDate
        ? acc.openingBalanceDate.toISOString().split('T')[0]
        : null,
      currentBalance,
      creditLimit: acc.creditLimit,
    }
  })

  // ── Cash flow statement (month by month, in date range) ────────────────────
  // Seed is liquid-cash only: summing loan/credit-card openings here would
  // inflate the opening row by the outstanding debt (which is not cash).
  //
  // We must apply the same hiddenTxIds filter to pre-range rows as the main
  // window — split parents and matched reimbursement pairs inflate the seed
  // otherwise, so the opening row disagrees with the sum of live asset rows.
  const assetAccounts = accountsForCurrency.filter((a) => isAsset(a.accountType))
  const assetAccountIds = assetAccounts.map((a) => a.id)
  let preRangeAssetSum = 0
  if (assetAccountIds.length > 0) {
    // Single grouped SUM with the same hidden-rows exclusion as the main
    // window (scoped to date < startDate). Includes transfers — the seed is a
    // raw signed balance, not an income/expense figure.
    const [preRow] = await prisma.$queryRawUnsafe<{ s: number | bigint }[]>(
      preRangeAssetSumSql(assetAccountIds, startIso),
    )
    preRangeAssetSum = num(preRow?.s)
  }
  const cashFlowData: CashFlowRow[] = []
  {
    const seedBalance = assetAccounts.reduce((sum, a) => sum + a.openingBalance, 0)
      + preRangeAssetSum
    let runningBalance = seedBalance
    for (const [key, { income, expenses }] of monthMap.entries()) {
      cashFlowData.push({
        period: monthLabel(key),
        openingBalance: runningBalance,
        income,
        expenses,
        closingBalance: runningBalance + income - expenses,
      })
      runningBalance = runningBalance + income - expenses
    }
  }

  // ── Category trend data ─────────────────────────────────────────────────────
  // Trend categories are the debit-in-range categories (identical set to the
  // category breakdown); colours come from the Category table.
  const dbCategories = await prisma.category.findMany({ orderBy: { name: 'asc' } })
  const dbColorByName = new Map(dbCategories.map((c) => [c.name, c.color]))
  const trendCategories: TrendCategory[] = categoryBreakdown
    .map((c) => ({ name: c.category, color: dbColorByName.get(c.category) ?? '#94a3b8' }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const trendMonthMap = new Map<string, Record<string, number>>()
  for (const key of monthMap.keys()) {
    const row: Record<string, number> = { month: 0 } // placeholder; month label added below
    for (const cat of trendCategories) row[cat.name] = 0
    trendMonthMap.set(key, row)
  }
  for (const r of trendRows) {
    const row = trendMonthMap.get(r.ym)
    if (row) row[r.category] = (row[r.category] ?? 0) + num(r.total)
  }
  const categoryTrendData = Array.from(trendMonthMap.entries()).map(([key, row]) => ({
    month: monthLabel(key),
    ...row,
  }))

  // ── Budget data (follows the dashboard date range) ───────────
  // Actuals = category spend in the selected window (rangeCatMap, computed with
  // the category breakdown above). Budget scales by the number of months
  // covered so a 3-month window compares against 3× the monthly limit.
  const monthsInRange = Math.max(1, monthMap.size)
  const budgetData: BudgetData[] = budgets.map((b) => ({
    category: b.category,
    budget: b.monthlyLimit * monthsInRange,
    actual: rangeCatMap.get(b.category) ?? 0,
  }))

  // ── Top 10 transactions ──────────────────────────────────────────────────────
  // Exclude transfers (movement between your own accounts isn't "spend" or
  // "income") and split parents (their legs carry the real breakdown), plus
  // both sides of a matched reimbursement pair: the expense side carries
  // reimbursementTxId (non-null); the settlement side is pointed at by the
  // inverse `reimbursedExpense` relation. Filtering both in the query removes
  // the previous full-set client-side hidden-id pass.
  const reimbursementFree = {
    reimbursementTxId: null,
    reimbursedExpense: { is: null },
  } as const
  const [topPositive, topNegative] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        accountId: { in: accountIds },
        status: { in: ['committed', 'reconciled'] },
        transactionType: { not: 'transfer' },
        parentTransactionId: null,
        amount: { gt: 0 },
        date: { gte: startDate, lte: endDate },
        ...reimbursementFree,
      },
      orderBy: { amount: 'desc' },
      take: 20,
      include: { account: { select: { name: true } } },
    }),
    prisma.transaction.findMany({
      where: {
        accountId: { in: accountIds },
        status: { in: ['committed', 'reconciled'] },
        transactionType: { not: 'transfer' },
        parentTransactionId: null,
        amount: { lt: 0 },
        date: { gte: startDate, lte: endDate },
        ...reimbursementFree,
      },
      orderBy: { amount: 'asc' },
      take: 20,
      include: { account: { select: { name: true } } },
    }),
  ])

  const topTransactions: TopTransaction[] = [...topPositive, ...topNegative]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 10)
    .map((t) => ({
      id: t.id,
      date: new Date(t.date).toISOString().split('T')[0],
      description: t.description,
      amount: t.amount,
      category: t.category,
      accountName: t.account.name,
    }))

  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h1 className="text-[26px] font-semibold leading-[1.25]" style={{ letterSpacing: '-0.325px' }}>
            Dashboard
          </h1>
          <p className="mt-1 text-sm leading-[1.5]" style={{ color: 'var(--tx-secondary)' }}>
            Spending overview and trends.
          </p>
        </div>
        <DashboardView
          categoryBreakdown={categoryBreakdown}
          monthlyData={monthlyData}
          summaryStats={summaryStats}
          currency={selectedCurrency}
          availableCurrencies={availableCurrencies}
          selectedCurrency={selectedCurrency}
          accountBalances={accountBalances}
          cashFlowData={cashFlowData}
          categoryTrendData={categoryTrendData}
          trendCategories={trendCategories}
          topTransactions={topTransactions}
          currentStartDate={startDate.toISOString().split('T')[0]}
          currentEndDate={endDate.toISOString().split('T')[0]}
          budgetData={budgetData}
        />
      </div>
    </div>
  )
}
