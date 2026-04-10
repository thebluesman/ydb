import { prisma } from '@/lib/prisma'
import { DashboardView } from './_components/DashboardView'

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
  const endDate = params.endDate ? new Date(params.endDate) : now
  const startDate = params.startDate
    ? new Date(params.startDate)
    : new Date(now.getFullYear(), now.getMonth() - 11, 1)

  // Clamp endDate to end-of-day
  endDate.setHours(23, 59, 59, 999)

  // ── Fetch transactions ─────────────────────────────────────────────────────
  const txs = await prisma.transaction.findMany({
    where: {
      accountId: { in: accountIds },
      status: { in: ['committed', 'reconciled'] },
    },
    orderBy: { date: 'asc' },
    include: { account: { select: { name: true } } },
  })

  // ── Category breakdown (expenses only, in date range, exclude Transfer) ────
  const catMap = new Map<string, { total: number; count: number }>()
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType === 'transfer') continue
    if (t.amount >= 0) continue
    const cur = catMap.get(t.category) ?? { total: 0, count: 0 }
    catMap.set(t.category, { total: cur.total + Math.abs(t.amount), count: cur.count + 1 })
  }
  const categoryBreakdown = Array.from(catMap.entries())
    .map(([category, { total, count }]) => ({ category, total, count }))
    .sort((a, b) => b.total - a.total)

  // ── Monthly data (in date range, exclude Transfer) ─────────────────────────
  const monthMap = new Map<string, { income: number; expenses: number }>()
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
  while (cur <= endDate) {
    monthMap.set(monthKey(cur), { income: 0, expenses: 0 })
    cur.setMonth(cur.getMonth() + 1)
  }
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType === 'transfer') continue
    const key = monthKey(d)
    const m = monthMap.get(key)
    if (!m) continue
    if (t.amount > 0) m.income += t.amount
    else m.expenses += Math.abs(t.amount)
  }
  const monthlyData = Array.from(monthMap.entries()).map(([key, { income, expenses }]) => ({
    month: monthLabel(key),
    income,
    expenses,
    net: income - expenses,
  }))

  // ── Summary stats (in date range, exclude Transfer) ─────────────────────────
  let totalIncome = 0, totalExpenses = 0, txCount = 0
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType === 'transfer') continue
    txCount++
    if (t.amount > 0) totalIncome += t.amount
    else totalExpenses += Math.abs(t.amount)
  }
  const summaryStats = { totalIncome, totalExpenses, net: totalIncome - totalExpenses, txCount }

  // ── Account balances ────────────────────────────────────────────────────────
  const accountBalances: AccountBalance[] = await Promise.all(
    accountsForCurrency.map(async (acc) => {
      const agg = await prisma.transaction.aggregate({
        where: { accountId: acc.id, status: { in: ['committed', 'reconciled'] } },
        _sum: { amount: true },
      })
      const currentBalance = acc.openingBalance + (agg._sum.amount ?? 0)
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
  )

  // ── Cash flow statement (month by month, in date range) ────────────────────
  const cashFlowData: CashFlowRow[] = []
  {
    const seedBalance = accountsForCurrency.reduce((sum, a) => sum + a.openingBalance, 0)
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
  const dbCategories = await prisma.category.findMany({ orderBy: { name: 'asc' } })
  const trendCategories: TrendCategory[] = []
  const trendCatSet = new Set<string>()

  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType === 'transfer' || t.amount >= 0) continue
    if (!trendCatSet.has(t.category)) {
      trendCatSet.add(t.category)
      const dbCat = dbCategories.find((c) => c.name === t.category)
      trendCategories.push({ name: t.category, color: dbCat?.color ?? '#94a3b8' })
    }
  }
  trendCategories.sort((a, b) => a.name.localeCompare(b.name))

  const trendMonthMap = new Map<string, Record<string, number>>()
  for (const key of monthMap.keys()) {
    const row: Record<string, number> = { month: 0 } // placeholder; month label added below
    for (const cat of trendCategories) row[cat.name] = 0
    trendMonthMap.set(key, row)
  }
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType === 'transfer' || t.amount >= 0) continue
    const key = monthKey(d)
    const row = trendMonthMap.get(key)
    if (row) row[t.category] = (row[t.category] ?? 0) + Math.abs(t.amount)
  }
  const categoryTrendData = Array.from(trendMonthMap.entries()).map(([key, row]) => ({
    month: monthLabel(key),
    ...row,
  }))

  // ── Budget data (current month actuals, independent of date range) ───────────
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const currentMonthCatMap = new Map<string, number>()
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < currentMonthStart || d > now) continue
    if (t.transactionType === 'transfer' || t.amount >= 0) continue
    currentMonthCatMap.set(t.category, (currentMonthCatMap.get(t.category) ?? 0) + Math.abs(t.amount))
  }
  const budgetData: BudgetData[] = budgets.map((b) => ({
    category: b.category,
    budget: b.monthlyLimit,
    actual: currentMonthCatMap.get(b.category) ?? 0,
  }))

  // ── Top 10 transactions ──────────────────────────────────────────────────────
  const [topPositive, topNegative] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        accountId: { in: accountIds },
        status: { in: ['committed', 'reconciled'] },
        amount: { gt: 0 },
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { amount: 'desc' },
      take: 10,
      include: { account: { select: { name: true } } },
    }),
    prisma.transaction.findMany({
      where: {
        accountId: { in: accountIds },
        status: { in: ['committed', 'reconciled'] },
        amount: { lt: 0 },
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { amount: 'asc' },
      take: 10,
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
