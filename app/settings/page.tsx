import { prisma } from '@/lib/prisma'
import { PreferencesForm } from './_components/PreferencesForm'
import { SettingsCategoryBridge } from './_components/SettingsCategoryBridge'
import { BudgetManager } from './_components/BudgetManager'
import { RecurringTransactions } from './_components/RecurringTransactions'
import { ImportHistory } from './_components/ImportHistory'
import { DangerZone } from './_components/DangerZone'
import { BackupManager } from './_components/BackupManager'
import { ReconciliationManager } from './_components/ReconciliationManager'
import { SettingsSubNav } from './_components/SettingsSubNav'
import { listBackups } from '@/lib/backup'

export const metadata = {
  title: 'Settings — ydb',
}

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const backups = listBackups()

  const [rawAccounts, categories, settings, rawVendorRules, budgets, rawImportRecords] = await Promise.all([
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
  ])
  // Match counts are no longer computed here (that pulled 5,000 rows and ran
  // every rule against them on each render, blocking the page). They are
  // fetched lazily client-side via GET /api/vendor-rules?withCounts=1.
  // The category-colour migration likewise moved to the instrumentation.ts
  // startup hook so this page never performs DB writes during render.
  const vendorRules = rawVendorRules.map((r) => ({ ...r, matchCount: 0 }))
  const importRecords = rawImportRecords.map((r) => ({
    ...r,
    importedAt: r.importedAt.toISOString(),
  }))

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
        <SettingsSubNav />
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
          preferencesSlot={<PreferencesForm key="preferences" initialSettings={settings} />}
        />

        {/* Budgets card */}
        <div
          id="budgets"
          className="p-6 rounded-[8px] scroll-mt-24"
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
          id="recurring"
          className="p-6 rounded-[8px] scroll-mt-24"
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

        {/* Reconciliation card */}
        <div
          className="p-6 rounded-[8px]"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
        >
          <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
            Reconcile an Account
          </h2>
          <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
            Enter a statement&apos;s closing balance and date to check it against committed transactions,
            then mark that period reconciled once they match.
          </p>
          <ReconciliationManager
            accounts={rawAccounts.map((a) => ({
              id: a.id,
              name: a.name,
              currency: a.currency,
              lastReconciledAt: a.lastReconciledAt ? a.lastReconciledAt.toISOString() : null,
              lastReconciledBalance: a.lastReconciledBalance,
            }))}
          />
        </div>

        {/* Import history card */}
        <div
          id="imports"
          className="p-6 rounded-[8px] scroll-mt-24"
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
          id="backups"
          className="p-6 rounded-[8px] scroll-mt-24"
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

        <div id="danger-zone" className="scroll-mt-24">
          <DangerZone />
        </div>
      </div>
    </div>
  )
}
