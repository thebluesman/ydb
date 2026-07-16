import { prisma } from '@/lib/prisma'
import { LedgerView } from './_components/LedgerView'
import {
  TRANSACTION_INCLUDE,
  buildPendingSql,
  buildPrismaWhere,
  buildStatsSql,
  parseLedgerQuery,
  resolveCurrencyScope,
  toNumber,
} from '@/lib/transactions-query'

export const metadata = {
  title: 'Ledger — ydb',
}

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v)
    else if (Array.isArray(v) && v[0] != null) usp.set(k, v[0])
  }
  const q = parseLedgerQuery(usp)

  const [accounts, categories, baseCurrencySetting] = await Promise.all([
    prisma.account.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    prisma.setting.findFirst({ where: { key: 'baseCurrency' } }),
  ])

  const baseCurrency = baseCurrencySetting?.value ?? accounts[0]?.currency ?? 'GBP'
  const scope = resolveCurrencyScope(accounts, q.accountId, baseCurrency)
  const where = buildPrismaWhere(q, scope)
  const stats = buildStatsSql(q, scope)
  const pending = buildPendingSql(scope, q.accountId)

  const [rows, total, statsRows, pendingRows] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { [q.sort]: q.dir },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: TRANSACTION_INCLUDE,
    }),
    prisma.transaction.count({ where }),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(stats.sql, ...stats.params),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(pending.sql, ...pending.params),
  ])

  const s = statsRows[0] ?? {}
  const p = pendingRows[0] ?? {}
  const income = toNumber(s.income)
  const expenses = toNumber(s.expenses)

  const initialStats = {
    income,
    expenses,
    net: income - expenses,
    incomeCount: toNumber(s.incomeCount),
    expenseCount: toNumber(s.expenseCount),
    currency: scope.currency,
    pendingReimbursementCount: toNumber(p.count),
    pendingReimbursementOutstanding: toNumber(p.outstanding),
  }

  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-6xl mx-auto space-y-8">
        <LedgerView
          initialRows={rows}
          initialTotal={total}
          initialStats={initialStats}
          accounts={accounts}
          categories={categories}
        />
      </div>
    </div>
  )
}
