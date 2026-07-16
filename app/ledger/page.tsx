import { prisma } from '@/lib/prisma'
import { LedgerView } from './_components/LedgerView'
import {
  TRANSACTION_INCLUDE,
  buildCountSql,
  buildPageIdsSql,
  buildPendingSql,
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

  // Distinct categories across the WHOLE table (not just the current page), so
  // the ledger's category filter lists ad-hoc categories that live on other
  // pages too. Defined categories are unioned in on the client.
  const [accounts, categories, distinctCategoryRows, baseCurrencySetting] = await Promise.all([
    prisma.account.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    prisma.transaction.findMany({
      where: { category: { not: '' } },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    }),
    prisma.setting.findFirst({ where: { key: 'baseCurrency' } }),
  ])
  const categoryOptions = distinctCategoryRows.map((r) => r.category)

  const baseCurrency = baseCurrencySetting?.value ?? accounts[0]?.currency ?? 'GBP'
  const scope = resolveCurrencyScope(accounts, q.accountId, baseCurrency)
  const pageIds = buildPageIdsSql(q, scope)
  const countSql = buildCountSql(q, scope)
  const stats = buildStatsSql(q, scope)
  const pending = buildPendingSql(scope, q.accountId)

  // Page rows, count, stats and pending all derive from the one raw predicate
  // (buildFilterSql) so the visible rows and the stat counts can't diverge on a
  // `%`/`_` search term. Rows are selected by id, then hydrated with relations.
  const [idRows, countRows, statsRows, pendingRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ id: number }>>(pageIds.sql, ...pageIds.params),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(countSql.sql, ...countSql.params),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(stats.sql, ...stats.params),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(pending.sql, ...pending.params),
  ])

  const ids = idRows.map((r) => toNumber(r.id))
  const unordered =
    ids.length > 0
      ? await prisma.transaction.findMany({ where: { id: { in: ids } }, include: TRANSACTION_INCLUDE })
      : []
  const byId = new Map(unordered.map((r) => [r.id, r]))
  const rows = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r != null)
  const total = toNumber(countRows[0]?.count)

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
          categoryOptions={categoryOptions}
        />
      </div>
    </div>
  )
}
