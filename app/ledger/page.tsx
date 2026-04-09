import { prisma } from '@/lib/prisma'
import { LedgerView } from './_components/LedgerView'

export const metadata = {
  title: 'Ledger — ydb',
}

export default async function LedgerPage() {
  const [transactions, accounts, categories, baseCurrencySetting] = await Promise.all([
    prisma.transaction.findMany({
      orderBy: { date: 'desc' },
      include: {
        account: { select: { name: true, currency: true } },
        splitLegs: { select: { id: true, amount: true, category: true, description: true } },
        reimbursementTx: { select: { id: true, amount: true, description: true } },
        reimbursedExpense: { select: { id: true, description: true } },
      },
    }),
    prisma.account.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    prisma.setting.findFirst({ where: { key: 'baseCurrency' } }),
  ])

  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-6xl mx-auto space-y-8">
        <LedgerView
          initialTransactions={transactions}
          accounts={accounts}
          categories={categories}
          baseCurrency={baseCurrencySetting?.value ?? accounts[0]?.currency ?? 'GBP'}
        />
      </div>
    </div>
  )
}
