'use client'

import { useState } from 'react'
import { UploadFlow } from './UploadFlow'
import { CsvImportFlow } from './CsvImportFlow'

type Account = { id: number; name: string; currency: string; accountType: string }
type Category = { id: number; name: string; color: string }
type Tab = 'statement' | 'csv'

const TABS: { value: Tab; label: string }[] = [
  { value: 'statement', label: 'Statement (PDF / Image)' },
  { value: 'csv', label: 'CSV / OFX' },
]

export function UploadTabs({ accounts, categories }: { accounts: Account[]; categories: Category[] }) {
  const [tab, setTab] = useState<Tab>('statement')

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Import method"
        className="inline-flex gap-1 p-1 rounded-[8px]"
        style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)' }}
      >
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className="btn px-3 py-1.5 text-sm font-medium rounded-[6px] transition-colors duration-150"
            style={tab === t.value
              ? { backgroundColor: 'var(--bg-selected)', color: 'var(--tx-selected)' }
              : { color: 'var(--tx-secondary)' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'statement'
        ? <UploadFlow accounts={accounts} categories={categories} />
        : <CsvImportFlow accounts={accounts} categories={categories} />}
    </div>
  )
}
