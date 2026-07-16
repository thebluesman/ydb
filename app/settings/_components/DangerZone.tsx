'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { Modal, Button } from '@/app/_components/ui'

type ClearScope = {
  transactions: boolean
  importHistory: boolean
  accounts: boolean
  categories: boolean
  patterns: boolean
  chatHistory: boolean
}

const DEFAULT_SCOPE: ClearScope = {
  transactions: false,
  importHistory: false,
  accounts: false,
  categories: false,
  patterns: false,
  chatHistory: false,
}

const ROWS: { key: keyof ClearScope; label: string; sub: string; danger?: true }[] = [
  { key: 'transactions',  label: 'Transactions',   sub: 'All ledger entries' },
  { key: 'importHistory', label: 'Import History',  sub: 'Upload log only — keeps transactions' },
  { key: 'accounts',      label: 'Accounts',        sub: 'Also clears transactions & import history', danger: true },
  { key: 'categories',    label: 'Categories',      sub: 'Also removes budget targets' },
  { key: 'patterns',      label: 'Patterns',        sub: 'All vendor rules' },
  { key: 'chatHistory',   label: 'Chat History',    sub: 'AI assistant conversation history' },
]

export function DangerZone() {
  const router = useRouter()
  const [showModal, setShowModal] = useState(false)
  const [scope, setScope] = useState<ClearScope>(DEFAULT_SCOPE)
  const [confirmText, setConfirmText] = useState('')
  const [clearing, setClearing] = useState(false)

  const anySelected = Object.values(scope).some(Boolean)
  const canConfirm = anySelected && confirmText === 'DELETE'

  const toggle = (key: keyof ClearScope) => {
    setScope((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      // Selecting Accounts forces Transactions + Import History on (FK dependency)
      if (key === 'accounts' && next.accounts) {
        next.transactions = true
        next.importHistory = true
      }
      // Unchecking Transactions or Import History while Accounts is on → uncheck Accounts too
      if ((key === 'transactions' || key === 'importHistory') && !next[key] && next.accounts) {
        next.accounts = false
      }
      return next
    })
  }

  const close = () => {
    if (clearing) return
    setShowModal(false)
    setScope(DEFAULT_SCOPE)
    setConfirmText('')
  }

  const handleClear = async () => {
    if (!canConfirm || clearing) return
    setClearing(true)
    await fetch('/api/clear-data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE ALL DATA', scope }),
    })
    router.refresh()
    setClearing(false)
    close()
  }

  return (
    <>
      <div
        className="p-6 rounded-[8px]"
        style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
      >
        <h2 className="text-section mb-1">
          Danger Zone
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
          Selectively clear data. Settings and preferences are always preserved. Cannot be undone.
        </p>
        <button
          onClick={() => setShowModal(true)}
          className="btn px-[12px] py-[7px] text-sm rounded-[8px] transition-colors duration-150"
          style={{
            backgroundColor: 'var(--bg-notify-error)',
            color: 'var(--tx-notify-error)',
            border: '1px solid var(--border-warm)',
          }}
        >
          Clear Data…
        </button>
      </div>

      <Modal
        open={showModal}
        onClose={close}
        maxWidth={448}
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle size={15} style={{ color: 'var(--tx-error)' }} />
            Clear Data
          </span>
        }
      >
        <div className="space-y-5">
            {/* Checkboxes */}
            <div className="space-y-0.5">
              {ROWS.map(({ key, label, sub, danger }) => {
                const locked = clearing ||
                  (key === 'transactions' && scope.accounts) ||
                  (key === 'importHistory' && scope.accounts)
                return (
                  <label
                    key={key}
                    className="flex items-start gap-3 px-3 py-2.5 rounded-[8px] cursor-pointer select-none"
                    style={{
                      backgroundColor: scope[key] ? 'var(--bg-notify-error)' : 'transparent',
                      cursor: locked ? 'default' : 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={scope[key]}
                      onChange={() => !locked && toggle(key)}
                      disabled={locked}
                      className="mt-[3px] flex-shrink-0"
                    />
                    <div>
                      <div
                        className="text-sm font-medium leading-snug"
                        style={{ color: danger ? 'var(--tx-error)' : 'var(--tx-primary)' }}
                      >
                        {label}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--tx-secondary)' }}>
                        {sub}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>

            {/* Confirm input */}
            <div className="space-y-1.5">
              <label
                className="block text-[11px] font-medium uppercase tracking-wider"
                style={{ color: anySelected ? 'var(--tx-tertiary)' : 'var(--tx-tertiary)', opacity: anySelected ? 1 : 0.4 }}
              >
                Type DELETE to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onPaste={(e) => e.preventDefault()}
                placeholder="DELETE"
                disabled={!anySelected || clearing}
                autoComplete="off"
                className="w-full px-3 py-2 text-sm rounded-[8px] outline-none font-mono disabled:opacity-40"
                style={{
                  border: `1px solid ${confirmText === 'DELETE' && anySelected ? 'var(--tx-error)' : 'var(--border-warm)'}`,
                  backgroundColor: 'var(--bg-input)',
                  color: 'var(--tx-primary)',
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleClear() }}
              />
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3">
              <Button variant="ghost" size="sm" onClick={close} disabled={clearing}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                onClick={handleClear}
                disabled={!canConfirm || clearing}
              >
                {clearing ? 'Clearing…' : 'Clear Selected'}
              </Button>
            </div>
        </div>
      </Modal>
    </>
  )
}
