'use client'

import { useState } from 'react'
import { CheckCircle2, RotateCcw } from 'lucide-react'

export function FormatDemo() {
  const [active, setActive] = useState('credit-card')
  const formats = [
    { id: 'credit-card', label: 'Credit Card', hint: 'Single amount column. Positive = expense, CR suffix = payment.' },
    { id: 'bank-account', label: 'Bank Account', hint: 'Separate Debit and Credit columns.' },
    { id: 'auto', label: 'Auto', hint: "Let Qwen figure it out — works for most statements." },
  ]
  const active_fmt = formats.find(f => f.id === active)
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap justify-center">
        {formats.map((f) => (
          <button
            key={f.id}
            onClick={() => setActive(f.id)}
            className="btn px-3 py-1.5 text-sm rounded-[8px] transition-all duration-150"
            style={{
              background: active === f.id ? 'var(--bg-selected)' : 'var(--bg-btn)',
              color: active === f.id ? 'var(--tx-selected)' : 'var(--tx-secondary)',
              border: `1px solid ${active === f.id ? 'var(--bg-selected)' : 'var(--border-warm)'}`,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-center" style={{ color: 'var(--tx-secondary)' }}>{active_fmt?.hint}</p>
    </div>
  )
}

export function TransactionRowDemo({ currency }: { currency: string }) {
  const [committed, setCommitted] = useState(false)
  return (
    <div className="space-y-2">
      <div
        className="flex items-center gap-3 px-3 py-2.5 rounded-[6px] text-sm"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
      >
        <span className="w-24 shrink-0 font-mono text-xs" style={{ color: 'var(--tx-tertiary)' }}>2024-03-15</span>
        <span className="flex-1 truncate" style={{ color: 'var(--tx-primary)' }}>NETFLIX.COM</span>
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
          style={{ background: '#1D4ED8', color: '#fff' }}
        >
          Entertainment
        </span>
        <span className="font-mono text-sm shrink-0" style={{ color: 'var(--tx-error)', letterSpacing: '-0.275px' }}>-{currency} 15.99</span>
        <span
          className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
          style={{
            background: committed ? 'var(--bg-badge-committed)' : 'var(--bg-badge-review)',
            color: committed ? 'var(--tx-badge-committed)' : 'var(--tx-badge-review)',
          }}
        >
          {committed ? 'Committed' : 'Review'}
        </span>
        <button
          onClick={() => setCommitted(!committed)}
          className="btn text-xs px-2.5 py-1 rounded-[6px] transition-colors duration-150 shrink-0"
          style={{ background: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
        >
          {committed ? 'Undo' : 'Commit'}
        </button>
      </div>
      <p className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>
        {committed ? '✓ Transaction committed to ledger.' : 'Click Commit to move this to the permanent ledger.'}
      </p>
    </div>
  )
}

export function ChatConversationDemo({ currency }: { currency: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="w-full space-y-3 text-sm">
      {/* User bubble */}
      <div className="flex justify-end">
        <div
          className="px-3.5 py-2.5 rounded-[14px] rounded-tr-[4px] max-w-[80%]"
          style={{ background: 'var(--bg-selected)', color: 'var(--tx-selected)' }}
        >
          What were my top 3 spending categories last month?
        </div>
      </div>
      {/* Assistant bubble */}
      <div className="flex justify-start">
        <div className="max-w-[85%] space-y-1.5">
          <div
            className="px-3.5 py-2.5 rounded-[14px] rounded-tl-[4px]"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            Last month your top three spending categories were <strong>Dining</strong> (−{currency} 342.10),{' '}
            <strong>Groceries</strong> (−{currency} 289.45), and <strong>Transport</strong> (−{currency} 104.80).
          </div>
          {/* Show SQL toggle */}
          <div>
            <button
              onClick={() => setOpen((o) => !o)}
              className="btn flex items-center gap-1.5 text-xs transition-opacity duration-150"
              style={{ color: 'var(--tx-tertiary)', opacity: 0.75 }}
            >
              <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
              Show SQL
            </button>
            {open && (
              <pre
                className="mt-1.5 px-3 py-2.5 rounded-[8px] text-[11px] overflow-x-auto"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-warm)',
                  color: 'var(--tx-secondary)',
                  fontFamily: 'ui-monospace, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
{`SELECT category, SUM(amount) AS total
FROM "Transaction"
WHERE amount < 0
  AND strftime('%Y-%m', date) =
      strftime('%Y-%m', date('now','-1 month'))
  AND status IN ('committed','reconciled')
GROUP BY category
ORDER BY total ASC
LIMIT 3`}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ReimbursementDemo({ currency }: { currency: string }) {
  const [settled, setSettled] = useState(false)
  return (
    <div className="w-full space-y-2">
      {/* Pending banner */}
      {!settled && (
        <div
          className="flex items-center gap-2.5 px-3 py-2.5 rounded-[8px] text-xs"
          style={{ backgroundColor: 'var(--bg-badge-review)', border: '1px solid var(--border-warm)', color: 'var(--tx-badge-review)' }}
        >
          <RotateCcw size={14} style={{ flexShrink: 0 }} />
          <span>1 pending reimbursement awaiting settlement — {currency} 500.00 outstanding</span>
          <span className="ml-auto" style={{ color: 'var(--tx-secondary)' }}>Filter</span>
        </div>
      )}

      {/* Expense row */}
      <div
        className="flex items-center gap-3 px-3 py-2.5 rounded-[6px] text-sm"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
      >
        <span className="w-24 shrink-0 font-mono text-[11px]" style={{ color: 'var(--tx-tertiary)' }}>2024-03-10</span>
        <span className="flex-1 flex items-center gap-1.5 min-w-0" style={{ color: 'var(--tx-primary)' }}>
          <span className="truncate">Dubai Hospital</span>
          {settled
            ? <CheckCircle2 size={12} style={{ color: '#34d399', flexShrink: 0 }} />
            : <RotateCcw size={12} style={{ color: 'var(--tx-faint)', flexShrink: 0 }} />}
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: '#0E7490', color: '#fff' }}>
          Healthcare
        </span>
        <div className="font-mono text-sm shrink-0 text-right" style={{ letterSpacing: '-0.275px' }}>
          <div style={{ color: '#f87171' }}>−{currency} 500.00</div>
          {settled && (
            <div className="text-[10px] font-normal" style={{ color: 'var(--tx-secondary)', letterSpacing: 0 }}>
              net −{currency} 50.00
            </div>
          )}
        </div>
      </div>

      {/* Settlement credit — visible once linked */}
      {settled && (
        <div
          className="flex items-center gap-3 px-3 py-2 ml-6 rounded-[6px] text-sm"
          style={{ background: 'var(--bg-page)', border: '1px solid var(--border-warm)' }}
        >
          <span className="w-24 shrink-0 font-mono text-[11px]" style={{ color: 'var(--tx-tertiary)' }}>2024-03-24</span>
          <span className="flex-1 flex items-center gap-1.5" style={{ color: 'var(--tx-secondary)' }}>
            <RotateCcw size={12} style={{ color: '#34d399' }} />
            Insurance Refund
          </span>
          <span className="font-mono text-sm" style={{ color: '#34d399', letterSpacing: '-0.275px' }}>
            +{currency} 450.00
          </span>
        </div>
      )}

      {/* Action */}
      <div className="flex justify-center pt-1">
        {settled ? (
          <button
            onClick={() => setSettled(false)}
            className="btn text-xs transition-opacity duration-150 hover:opacity-100"
            style={{ color: 'var(--tx-tertiary)', opacity: 0.6 }}
          >
            Reset
          </button>
        ) : (
          <button
            onClick={() => setSettled(true)}
            className="btn text-xs px-3 py-1.5 rounded-[6px] transition-colors duration-150"
            style={{ background: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            Link reimbursement →
          </button>
        )}
      </div>
    </div>
  )
}
