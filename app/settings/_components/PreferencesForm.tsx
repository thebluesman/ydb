'use client'

import { useState } from 'react'
import * as Select from '@radix-ui/react-select'
import { ChevronDown } from 'lucide-react'

const CURRENCIES = ['GBP', 'USD', 'EUR', 'AED', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF']

type Setting = { key: string; value: string }

export function PreferencesForm({ initialSettings }: { initialSettings: Setting[] }) {
  const initial = initialSettings.find((s) => s.key === 'baseCurrency')?.value ?? 'GBP'
  const [baseCurrency, setBaseCurrency] = useState(initial)
  const [saved, setSaved] = useState(false)

  const handleChange = async (value: string) => {
    setBaseCurrency(value)
    setSaved(false)
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'baseCurrency', value }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* silent */ }
  }

  return (
    <div
      className="p-6 rounded-[8px]"
      style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
    >
      <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
        Preferences
      </h2>
      <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
        Default currency shown on the dashboard when no filter is selected.
      </p>

      <div className="flex items-center gap-3">
        <label className="text-sm" style={{ color: 'var(--tx-primary)' }}>
          Base Currency
        </label>
        <Select.Root value={baseCurrency} onValueChange={handleChange}>
          <Select.Trigger
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-[8px] outline-none font-mono min-w-[90px]"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
          >
            <Select.Value />
            <Select.Icon className="ml-auto" style={{ color: 'var(--tx-tertiary)' }}>
              <ChevronDown size={14} />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper" sideOffset={4} className="rounded-[8px] z-50 overflow-hidden"
              style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)' }}
            >
              <Select.Viewport className="p-1">
                {CURRENCIES.map((c) => (
                  <Select.Item
                    key={c}
                    value={c}
                    className="px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none font-mono transition-colors duration-100"
                    style={{ color: 'var(--tx-primary)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <Select.ItemText>{c}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        {saved && (
          <span className="text-xs" style={{ color: 'var(--tx-success)' }}>Saved</span>
        )}
      </div>
    </div>
  )
}
