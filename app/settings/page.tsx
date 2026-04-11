import { prisma } from '@/lib/prisma'
import { colorForCategory, PALETTE } from '@/lib/category-colors'
import { countMatchingTransactions } from '@/lib/vendor-rule-match'
import { PreferencesForm } from './_components/PreferencesForm'
import { SettingsCategoryBridge } from './_components/SettingsCategoryBridge'
import { BudgetManager } from './_components/BudgetManager'
import { RecurringTransactions } from './_components/RecurringTransactions'
import { ImportHistory } from './_components/ImportHistory'
import { DangerZone } from './_components/DangerZone'
import { BackupManager } from './_components/BackupManager'
import { listBackups } from '@/lib/backup'

export const metadata = {
  title: 'Settings — ydb',
}

export default async function SettingsPage() {
  const backups = listBackups()

  const [rawAccounts, categories, settings, rawVendorRules, budgets, rawImportRecords, committedTxns] = await Promise.all([
    prisma.account.findMany({ orderBy: { id: 'asc' } }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    prisma.setting.findMany(),
    prisma.vendorRule.findMany({ orderBy: [{ priority: 'asc' }, { vendor: 'asc' }] }),
    prisma.budget.findMany({ orderBy: { category: 'asc' } }),
    prisma.importRecord.findMany({
      orderBy: { importedAt: 'desc' },
      take: 50,
      include: { account: { select: { name: true } } },
    }),
    prisma.transaction.findMany({
      where: { status: { in: ['committed', 'reconciled'] } },
      select: { description: true, originalDescription: true, amount: true },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    }),
  ])
  const vendorRules = rawVendorRules.map((r) => ({
    ...r,
    matchCount: countMatchingTransactions(r, committedTxns),
  }))
  const importRecords = rawImportRecords.map((r) => ({
    ...r,
    importedAt: r.importedAt.toISOString(),
  }))

  // Migrate any categories that aren't using a palette colour
  const stale = categories.filter((c) => !PALETTE.includes(c.color))
  if (stale.length > 0) {
    await Promise.all(
      stale.map((c) => prisma.category.update({ where: { id: c.id }, data: { color: colorForCategory(c.name) } }))
    )
    stale.forEach((c) => { c.color = colorForCategory(c.name) })
  }

  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1
            className="text-[26px] font-semibold text-cursor-dark leading-[1.25]"
            style={{ letterSpacing: '-0.325px' }}
          >
            Settings
          </h1>
          <p className="mt-1 text-sm leading-[1.5]" style={{ color: 'var(--tx-secondary)' }}>
            Configure your accounts, categories, and preferences.
          </p>
        </div>
        <SettingsCategoryBridge
          initialAccounts={rawAccounts.map((a) => ({
            ...a,
            openingBalanceDate: a.openingBalanceDate
              ? a.openingBalanceDate.toISOString().split('T')[0]
              : '',
          }))}
          initialCategories={categories}
          rules={vendorRules}
          currency={settings.find((s) => s.key === 'baseCurrency')?.value ?? 'GBP'}
          preferencesSlot={<PreferencesForm initialSettings={settings} />}
        />

        {/* Budgets card */}
        <div
          className="p-6 rounded-[8px]"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
        >
          <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
            Budgets
          </h2>
          <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
            Set monthly spending limits per category. Shown on the dashboard.
          </p>
          <BudgetManager initialBudgets={budgets} categories={categories} />
        </div>

        {/* Recurring transactions card */}
        <div
          className="p-6 rounded-[8px]"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
        >
          <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
            Recurring Transactions
          </h2>
          <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
            Detected from monthly patterns in your committed transactions.
          </p>
          <RecurringTransactions />
        </div>

        {/* Import history card */}
        <div
          className="p-6 rounded-[8px]"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
        >
          <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
            Import History
          </h2>
          <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
            Statements uploaded in this app.
          </p>
          <ImportHistory initialRecords={importRecords} />
        </div>

        {/* Backups card */}
        <div
          className="p-6 rounded-[8px]"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
        >
          <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
            Backups
          </h2>
          <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
            A backup is created automatically each day the app starts. You can also back up manually and download any snapshot.
          </p>
          <BackupManager initialBackups={backups} />
        </div>

        <DangerZone />
      </div>
    </div>
  )
}
