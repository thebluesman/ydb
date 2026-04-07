import { prisma } from '@/lib/prisma'
import { LedgerView } from './_components/LedgerView'

export const metadata = {
  title: 'Ledger — ydb',
}

export default async function LedgerPage() {
  const [transactions, accounts, categories] = await Promise.all([
    prisma.transaction.findMany({
      orderBy: { date: 'desc' },
      include: { account: { select: { name: true, currency: true } } },
    }),
    prisma.account.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
  ])

  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h1
            className="text-[26px] font-semibold text-cursor-dark leading-[1.25]"
            style={{ letterSpacing: '-0.325px' }}
          >
            Ledger
          </h1>
          <p className="mt-1 text-sm leading-[1.5]" style={{ color: 'var(--tx-secondary)' }}>
            All transactions — filter, edit, and manage.
          </p>
        </div>
        <LedgerView
          initialTransactions={transactions}
          accounts={accounts}
          categories={categories}
        />
      </div>
    </div>
  )
}
