'use client'

import { useState } from 'react'
import * as Checkbox from '@radix-ui/react-checkbox'
import * as Label from '@radix-ui/react-label'
import * as Select from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { CategoryManager } from './CategoryManager'

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
type Category = { id: number; name: string; color: string }

const labelCls = 'block text-[11px] font-medium uppercase tracking-[0.048px] mb-1'

const BLANK_ACCOUNT = (currency: string): Account => ({
  name: '',
  accountType: 'current',
  currency,
  isActive: true,
  openingBalance: 0,
  openingBalanceDate: '',
  creditLimit: null,
})

export function AccountsForm({
  initialAccounts,
  initialCategories,
  baseCurrency,
}: {
  initialAccounts: Account[]
  initialCategories: Category[]
  baseCurrency: string
}) {
  const [accounts, setAccounts] = useState<Account[]>(() =>
    initialAccounts.length > 0
      ? initialAccounts.map((a) => ({
          ...a,
          openingBalance: (a as Account).openingBalance ?? 0,
          openingBalanceDate: (a as Account).openingBalanceDate
            ? new Date((a as Account).openingBalanceDate).toISOString().split('T')[0]
            : '',
          creditLimit: (a as Account).creditLimit ?? null,
        }))
      : [BLANK_ACCOUNT(baseCurrency)]
  )
  const [categories, setCategories] = useState<Category[]>(initialCategories)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const updateAccount = (i: number, field: keyof Account, value: string | boolean | number) =>
    setAccounts((prev) => {
      const n = [...prev]
      n[i] = { ...n[i], [field]: value }
      return n
    })

  const addAccount = () => setAccounts((prev) => [...prev, BLANK_ACCOUNT(baseCurrency)])

  const removeAccount = async (i: number) => {
    const acc = accounts[i]
    if (!acc.id) {
      setAccounts((prev) => prev.filter((_, idx) => idx !== i))
      return
    }
    setRemoving(acc.id)
    try {
      const res = await fetch(`/api/accounts/${acc.id}`, { method: 'DELETE' })
      if (res.status === 409) {
        const data = await res.json()
        setStatus({
          type: 'error',
          message: `Cannot delete "${acc.name}" — it has ${data.count} transaction(s). Archive it instead by unchecking Active.`,
        })
        return
      }
      if (!res.ok) throw new Error(await res.text())
      setAccounts((prev) => prev.filter((_, idx) => idx !== i))
      setStatus({ type: 'success', message: `"${acc.name}" deleted.` })
    } catch (err) {
      setStatus({ type: 'error', message: String(err) })
    } finally {
      setRemoving(null)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const payload = accounts
        .filter((a) => a.name.trim())
        .map((a) => ({
          ...(a.id && { id: a.id }),
          name: a.name,
          accountType: a.accountType,
          currency: a.currency,
          isActive: a.isActive,
          openingBalance: a.openingBalance,
          openingBalanceDate: a.openingBalanceDate || null,
          creditLimit: a.accountType === 'credit' ? (a.creditLimit ?? null) : null,
        }))
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await res.text())
      const saved: Account[] = await res.json()
      // Merge saved ids back into local state
      setAccounts((prev) => {
        const namedSaved = saved.reverse()
        return prev.map((a) => {
          if (a.id) return a
          const match = namedSaved.find((s) => s.name === a.name)
          return match ? { ...a, id: match.id } : a
        })
      })
      setStatus({ type: 'success', message: 'Configuration saved.' })
    } catch (err) {
      setStatus({ type: 'error', message: String(err) })
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    border: '1px solid var(--border-warm)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx-primary)',
  }

  return (
    <div className="space-y-5">
      {/* Accounts card */}
      <div
        className="p-6 space-y-5 rounded-[8px]"
        style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', transition: 'box-shadow 0.18s ease, transform 0.18s ease' }}
      >
        <div>
          <h2 className="text-[22px] font-semibold" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
            Accounts
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--tx-secondary)' }}>
            Add as many accounts as you need. Set an opening balance from your oldest statement.
          </p>
        </div>

        {accounts.map((account, i) => (
          <div
            key={i}
            className="pb-5 last:pb-0 space-y-3"
            style={{ borderBottom: i < accounts.length - 1 ? '1px solid var(--border-warm)' : 'none' }}
          >
            {/* Row 1: Name, Type, Currency, Active */}
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
              <div>
                <Label.Root htmlFor={`acc-name-${i}`} className={labelCls} style={{ color: 'var(--tx-secondary)' }}>
                  Account Name
                </Label.Root>
                <input
                  id={`acc-name-${i}`}
                  type="text"
                  placeholder="e.g. Barclays Current"
                  value={account.name}
                  onChange={(e) => updateAccount(i, 'name', e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-[8px] outline-none transition-colors duration-150"
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
                />
              </div>

              <div>
                <Label.Root htmlFor={`acc-type-${i}`} className={labelCls} style={{ color: 'var(--tx-secondary)' }}>
                  Type
                </Label.Root>
                <Select.Root value={account.accountType} onValueChange={(v) => updateAccount(i, 'accountType', v)}>
                  <Select.Trigger
                    id={`acc-type-${i}`}
                    className="flex items-center gap-2 px-3 py-2 text-sm rounded-[8px] outline-none min-w-[110px]"
                    style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)', fontWeight: 400 }}
                  >
                    <Select.Value />
                    <Select.Icon className="ml-auto" style={{ color: 'var(--tx-tertiary)' }}><ChevronDown size={14} /></Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      position="popper" sideOffset={4}
                      className="rounded-[8px] z-50 overflow-hidden"
                      style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)' }}
                    >
                      <Select.Viewport className="p-1">
                        {([
                          ['current', 'Current'],
                          ['savings', 'Savings'],
                          ['credit', 'Credit Card'],
                          ['personal_loan', 'Personal Loan'],
                          ['auto_loan', 'Auto Loan'],
                        ] as [string, string][]).map(([value, label]) => (
                          <Select.Item
                            key={value}
                            value={value}
                            className="px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
                            style={{ color: 'var(--tx-primary)' }}
                            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                          >
                            <Select.ItemText>{label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              <div>
                <Label.Root htmlFor={`acc-currency-${i}`} className={labelCls} style={{ color: 'var(--tx-secondary)' }}>
                  Currency
                </Label.Root>
                <input
                  id={`acc-currency-${i}`}
                  type="text"
                  maxLength={3}
                  value={account.currency}
                  onChange={(e) => updateAccount(i, 'currency', e.target.value.toUpperCase())}
                  className="w-20 px-3 py-2 text-sm rounded-[8px] font-mono uppercase outline-none transition-colors duration-150"
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
                />
              </div>

              <div className="flex flex-col items-center">
                <Label.Root htmlFor={`acc-active-${i}`} className={labelCls} style={{ color: 'var(--tx-secondary)' }}>
                  Active
                </Label.Root>
                <div className="flex items-center h-[38px]">
                  <Checkbox.Root
                    id={`acc-active-${i}`}
                    checked={account.isActive}
                    onCheckedChange={(v) => updateAccount(i, 'isActive', v === true)}
                    title="Archive account"
                    className="flex items-center justify-center w-[18px] h-[18px] rounded-[4px] outline-none cursor-pointer transition-colors duration-150"
                    style={{
                      border: '1px solid var(--border-warm)',
                      backgroundColor: account.isActive ? 'var(--bg-nav-active)' : 'var(--bg-input)',
                    }}
                  >
                    <Checkbox.Indicator>
                      <Check size={11} strokeWidth={3} style={{ color: 'var(--tx-nav-active)' }} />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                </div>
              </div>
            </div>

            {/* Row 2: Opening balance + date + credit limit (credit only) + remove */}
            <div className="grid grid-cols-[auto_auto_auto_1fr] gap-3 items-end">
              <div>
                <Label.Root htmlFor={`acc-ob-${i}`} className={labelCls} style={{ color: 'var(--tx-secondary)' }}>
                  {account.accountType === 'personal_loan' || account.accountType === 'auto_loan'
                    ? 'Outstanding Balance'
                    : 'Opening Balance'}
                </Label.Root>
                <input
                  id={`acc-ob-${i}`}
                  type="number"
                  step="0.01"
                  value={account.openingBalance}
                  onChange={(e) => updateAccount(i, 'openingBalance', parseFloat(e.target.value) || 0)}
                  className="w-36 px-3 py-2 text-sm rounded-[8px] outline-none font-mono transition-colors duration-150"
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
                />
              </div>

              <div>
                <Label.Root htmlFor={`acc-obd-${i}`} className={labelCls} style={{ color: 'var(--tx-secondary)' }}>
                  As of Date
                </Label.Root>
                <input
                  id={`acc-obd-${i}`}
                  type="date"
                  value={account.openingBalanceDate}
                  onChange={(e) => updateAccount(i, 'openingBalanceDate', e.target.value)}
                  className="px-3 py-2 text-sm rounded-[8px] outline-none transition-colors duration-150"
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
                />
              </div>

              {account.accountType === 'credit' && (
                <div>
                  <Label.Root htmlFor={`acc-cl-${i}`} className={labelCls} style={{ color: 'var(--tx-secondary)' }}>
                    Credit Limit
                  </Label.Root>
                  <input
                    id={`acc-cl-${i}`}
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 5000"
                    value={account.creditLimit ?? ''}
                    onChange={(e) => { const v = e.target.value === '' ? null : parseFloat(e.target.value); setAccounts((prev) => { const n = [...prev]; n[i] = { ...n[i], creditLimit: v }; return n }) }}
                    className="w-36 px-3 py-2 text-sm rounded-[8px] outline-none font-mono transition-colors duration-150"
                    style={inputStyle}
                    onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
                  />
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={() => removeAccount(i)}
                  disabled={removing === account.id}
                  className="px-3 py-2 text-xs rounded-[8px] transition-colors duration-150 disabled:opacity-40"
                  style={{ backgroundColor: 'var(--bg-notify-error)', color: 'var(--tx-notify-error)', border: '1px solid var(--border-warm)' }}
                >
                  {removing === account.id ? '…' : 'Remove'}
                </button>
              </div>
            </div>
          </div>
        ))}

        <button
          onClick={addAccount}
          className="w-full py-2 text-sm rounded-[8px] transition-colors duration-150"
          style={{ border: '1px dashed var(--border-warm-md)', color: 'var(--tx-secondary)', backgroundColor: 'transparent' }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-strong)')}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
        >
          + Add Account
        </button>
      </div>

      {/* Categories card */}
      <div
        className="p-6 rounded-[8px]"
        style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
      >
        <h2 className="text-[22px] font-semibold mb-4" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
          Categories
        </h2>
        <CategoryManager categories={categories} onChange={setCategories} />
      </div>

      {/* Status */}
      {status && (
        <p
          className="px-4 py-3 rounded-[8px] text-sm"
          style={{
            backgroundColor: status.type === 'success' ? 'var(--bg-notify-success)' : 'var(--bg-notify-error)',
            color: status.type === 'success' ? 'var(--tx-notify-success)' : 'var(--tx-notify-error)',
            border: '1px solid var(--border-warm)',
          }}
        >
          {status.message}
        </p>
      )}

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full py-[10px] px-[14px] rounded-[8px] text-sm font-semibold transition-colors duration-150 hover:text-error disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
      >
        {saving ? 'Saving…' : 'Save Configuration'}
      </button>
    </div>
  )
}
