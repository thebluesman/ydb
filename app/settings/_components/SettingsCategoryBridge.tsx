'use client'

import { useState, type ReactNode } from 'react'
import { AccountsForm } from './AccountsForm'
import { VendorRuleManager } from './VendorRuleManager'

type Category = { id: number; name: string; color: string }
type Account = {
  id?: number
  name: string
  accountType: string
  currency: string
  isActive: boolean
  openingBalance: number
  openingBalanceDate: string
  creditLimit: number | null
}
type VendorRule = {
  id: number
  pattern: string
  matchType: string
  vendor: string
  category: string
  direction: string
  minAmount: number | null
  maxAmount: number | null
  priority: number
  matchCount: number
}

export function SettingsCategoryBridge({
  initialAccounts,
  initialCategories,
  baseCurrency,
  rules,
  currency,
  preferencesSlot,
}: {
  initialAccounts: Account[]
  initialCategories: Category[]
  baseCurrency: string
  rules: VendorRule[]
  currency: string
  preferencesSlot?: ReactNode
}) {
  const [categories, setCategories] = useState<Category[]>(initialCategories)

  return (
    <>
      <AccountsForm
        initialAccounts={initialAccounts}
        initialCategories={categories}
        baseCurrency={baseCurrency}
        onCategoriesChange={setCategories}
      />
      {preferencesSlot}
      <div
        className="p-6 rounded-[8px]"
        style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
      >
        <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
          Vendor Rules
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
          Teach Qwen how to categorise your recurring vendors. Explicit rules take priority over learned patterns.
        </p>
        <VendorRuleManager
          rules={rules}
          categories={categories}
          currency={currency}
        />
      </div>
    </>
  )
}
