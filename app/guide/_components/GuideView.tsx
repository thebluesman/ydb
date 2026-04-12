'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Upload, ScanText, CheckCircle, LayoutDashboard, Gem, ArrowRight, MessageCircle, Database, FileCode2, TextQuote, Link2, Scissors, Download, RefreshCw, Target, RotateCcw, CheckCircle2, FlaskConical, AlertTriangle, History, Settings } from 'lucide-react'

const SECTIONS = [
  { id: 'overview',        label: 'Overview',        num: '00' },
  { id: 'accounts',        label: 'Accounts',         num: '01' },
  { id: 'upload',          label: 'Upload',           num: '02' },
  { id: 'review',          label: 'Review',           num: '03' },
  { id: 'ledger',          label: 'Ledger',           num: '04' },
  { id: 'categories',      label: 'Categories & AI',  num: '05' },
  { id: 'budgets',         label: 'Budgets',          num: '06' },
  { id: 'dashboard',       label: 'Dashboard',        num: '07' },
  { id: 'recurring',       label: 'Recurring',        num: '08' },
  { id: 'chat',            label: 'Chat',             num: '09' },
  { id: 'reimbursements',  label: 'Reimbursements',   num: '10' },
  { id: 'backups',         label: 'Backups',          num: '11' },
  { id: 'settings',        label: 'Settings',         num: '12' },
]

// ── Inline demo components ────────────────────────────────────────────────────

function DemoShell({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <div
      className="mt-5 rounded-[10px] overflow-hidden"
      style={{ border: '1px solid var(--border-warm)', background: 'var(--bg-page)' }}
    >
      {label && (
        <div
          className="px-4 py-2 text-[11px] font-medium uppercase tracking-widest"
          style={{
            borderBottom: '1px solid var(--border-warm)',
            background: 'var(--bg-card-alt)',
            color: 'var(--tx-tertiary)',
            letterSpacing: '0.08em',
          }}
        >
          {label}
        </div>
      )}
      <div className="p-4 flex flex-col items-center">{children}</div>
    </div>
  )
}

function FlowDiagram() {
  const steps = [
    { icon: <Upload size={18} />, label: 'Upload', sub: 'PDF statement' },
    { icon: <ScanText size={18} />, label: 'Extract', sub: 'Qwen reads it' },
    { icon: <CheckCircle size={18} />, label: 'Review', sub: 'Edit & commit' },
    { icon: <LayoutDashboard size={18} />, label: 'Insights', sub: 'Dashboard' },
  ]
  return (
    <div className="flex items-center gap-0 flex-wrap justify-center">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center">
          <div className="flex flex-col items-center gap-1.5 px-3 py-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: i === 0 ? '#f54e00' : 'var(--bg-card-alt)', color: i === 0 ? '#fff' : 'var(--tx-primary)', border: '1px solid var(--border-warm)' }}
            >
              {s.icon}
            </div>
            <span className="text-xs font-medium" style={{ color: 'var(--tx-primary)' }}>{s.label}</span>
            <span className="text-[10px]" style={{ color: 'var(--tx-tertiary)' }}>{s.sub}</span>
          </div>
          {i < steps.length - 1 && (
            <div className="w-8 h-px mx-1 hidden sm:block" style={{ background: 'var(--border-warm-md)' }} />
          )}
        </div>
      ))}
    </div>
  )
}

function AccountCardDemo({ currency }: { currency: string }) {
  return (
    <div className="flex flex-wrap gap-3">
      {[
        { name: 'Barclays Current', type: 'CURRENT', balance: `${currency} 2,450.00`, color: '#1D4ED8' },
        { name: 'Amex Gold', type: 'CREDIT', balance: `-${currency} 340.50`, color: '#B91C1C' },
        { name: 'Honda Finance', type: 'AUTO LOAN', balance: `${currency} 8,200.00`, color: '#0E7490' },
      ].map((acc) => (
        <div
          key={acc.name}
          className="flex-none p-5 rounded-[8px] min-w-[180px]"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium truncate" style={{ color: 'var(--tx-primary)' }}>{acc.name}</span>
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
              style={{ background: acc.color, color: '#fff' }}
            >
              {acc.type}
            </span>
          </div>
          <div
            className="text-2xl font-mono tracking-tight"
            style={{ color: acc.balance.startsWith('-') ? 'var(--tx-error)' : 'var(--tx-success)', letterSpacing: '-0.5px' }}
          >
            {acc.balance}
          </div>
        </div>
      ))}
    </div>
  )
}

function FormatDemo() {
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
            className="px-3 py-1.5 text-sm rounded-[8px] transition-all duration-150"
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

function TransactionRowDemo({ currency }: { currency: string }) {
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
          className="text-xs px-2.5 py-1 rounded-[6px] transition-colors duration-150 shrink-0"
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

function StatusBadgeDemo() {
  const statuses = [
    { label: 'Review',     bg: 'var(--bg-badge-review)',      tx: 'var(--tx-badge-review)',      desc: 'Newly extracted. Needs your eyes.' },
    { label: 'Committed',  bg: 'var(--bg-badge-committed)',   tx: 'var(--tx-badge-committed)',   desc: 'Confirmed and locked into the ledger.' },
    { label: 'Reconciled', bg: 'var(--bg-badge-reconciled)',  tx: 'var(--tx-badge-reconciled)',  desc: 'Matched against a bank statement total.' },
  ]
  return (
    <div className="space-y-2">
      {statuses.map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <span
            className="text-xs px-2.5 py-0.5 rounded-full font-medium w-24 text-center shrink-0"
            style={{ background: s.bg, color: s.tx }}
          >
            {s.label}
          </span>
          <span className="text-sm" style={{ color: 'var(--tx-secondary)' }}>{s.desc}</span>
        </div>
      ))}
    </div>
  )
}

function CategoryPillsDemo() {
  const cats = [
    { name: 'Groceries',     color: '#15803D' },
    { name: 'Entertainment', color: '#1D4ED8' },
    { name: 'Transport',     color: '#B45309' },
    { name: 'Dining',        color: '#BE185D' },
    { name: 'Utilities',     color: '#0E7490' },
    { name: 'Income',        color: '#047857' },
    { name: 'Transfer',      color: '#0369A1' },
    { name: 'Other',         color: '#5B21B6' },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {cats.map((c) => (
        <span
          key={c.name}
          className="text-xs px-3 py-1 rounded-full font-medium"
          style={{ background: c.color, color: '#fff' }}
        >
          {c.name}
        </span>
      ))}
    </div>
  )
}

function PatternDemo() {
  const rows = [
    { raw: 'NFLX*123456789',       display: 'Netflix',    match: '~',  matchLabel: 'contains',    direction: null,      category: 'Entertainment', setType: null,       color: '#1D4ED8' },
    { raw: 'TESCO EXTRA LONDON',   display: 'Tesco',      match: '^',  matchLabel: 'starts-with', direction: null,      category: 'Groceries',     setType: null,       color: '#15803D' },
    { raw: 'CAREEM EATS',          display: 'Careem',     match: '~',  matchLabel: 'contains',    direction: '↓debit',  category: 'Dining',        setType: null,       color: '#B45309' },
    { raw: 'CAREEM RIDE',          display: 'Careem',     match: '~',  matchLabel: 'contains',    direction: '↓debit',  category: 'Transport',     setType: null,       color: '#B45309' },
    { raw: 'CREDIT CARD PAYMENT',  display: 'CC Payment', match: '~',  matchLabel: 'contains',    direction: null,      category: 'Transfers',     setType: 'transfer', color: '#6750A4' },
  ]
  return (
    <div className="rounded-[8px] overflow-hidden w-full" style={{ border: '1px solid var(--border-warm)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--bg-card-alt)', borderBottom: '1px solid var(--border-warm)' }}>
            {['Raw text', 'Display name', 'Match', 'Direction', 'Category', 'Set type'].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--tx-tertiary)' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--border-warm)' : 'none' }}>
              <td className="px-3 py-2.5 font-mono text-xs" style={{ color: 'var(--tx-faint)' }}>{r.raw}</td>
              <td className="px-3 py-2.5 font-medium" style={{ color: 'var(--tx-primary)' }}>{r.display}</td>
              <td className="px-3 py-2.5">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-[4px] font-mono"
                  style={{ background: 'var(--bg-card-alt)', color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
                  title={r.matchLabel}
                >
                  {r.match}
                </span>
              </td>
              <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--tx-faint)' }}>
                {r.direction ?? '—'}
              </td>
              <td className="px-3 py-2.5">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: r.color, color: '#fff' }}>
                  {r.category}
                </span>
              </td>
              <td className="px-3 py-2.5 text-xs" style={{ color: r.setType ? 'var(--tx-primary)' : 'var(--tx-faint)' }}>
                {r.setType ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatCardsDemo({ currency }: { currency: string }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {[
        { label: 'Total Income',   value: `${currency} 4,200.00`,  bg: 'var(--bg-stat-income)',  tx: 'var(--tx-stat-income)' },
        { label: 'Total Expenses', value: `${currency} 2,810.45`,  bg: 'var(--bg-stat-expense)', tx: 'var(--tx-stat-expense)' },
        { label: 'Net',            value: `+${currency} 1,389.55`, bg: 'var(--bg-stat-net)',     tx: 'var(--tx-stat-net-pos)' },
      ].map((s) => (
        <div
          key={s.label}
          className="p-3 rounded-[8px]"
          style={{ background: s.bg, border: '1px solid var(--border-warm)' }}
        >
          <div className="text-[11px] font-medium uppercase tracking-wide mb-1.5" style={{ color: s.tx, opacity: 0.7 }}>
            {s.label}
          </div>
          <div className="text-base font-mono font-medium" style={{ color: s.tx, letterSpacing: '-0.3px' }}>
            {s.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function ChatFlowDiagram() {
  const steps = [
    { icon: <MessageCircle size={18} />, label: 'Question', sub: 'Plain English' },
    { icon: <FileCode2 size={18} />,     label: 'SQL',      sub: 'Generated by AI' },
    { icon: <Database size={18} />,      label: 'Query',    sub: 'Run on SQLite' },
    { icon: <TextQuote size={18} />,     label: 'Answer',   sub: 'Narrated back' },
  ]
  return (
    <div className="flex items-center flex-wrap justify-center">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center">
          <div className="flex flex-col items-center gap-1.5 px-3 py-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{
                background: i === 0 ? '#f54e00' : 'var(--bg-card-alt)',
                color: i === 0 ? '#fff' : 'var(--tx-primary)',
                border: '1px solid var(--border-warm)',
              }}
            >
              {s.icon}
            </div>
            <span className="text-xs font-medium" style={{ color: 'var(--tx-primary)' }}>{s.label}</span>
            <span className="text-[10px]" style={{ color: 'var(--tx-tertiary)' }}>{s.sub}</span>
          </div>
          {i < steps.length - 1 && (
            <div className="w-8 h-px mx-1 hidden sm:block" style={{ background: 'var(--border-warm-md)' }} />
          )}
        </div>
      ))}
    </div>
  )
}

function ChatConversationDemo({ currency }: { currency: string }) {
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
              className="flex items-center gap-1.5 text-xs transition-opacity duration-150"
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

function ReimbursementDemo({ currency }: { currency: string }) {
  const [settled, setSettled] = useState(false)
  return (
    <div className="w-full space-y-2">
      {/* Pending banner */}
      {!settled && (
        <div
          className="flex items-center gap-2.5 px-3 py-2.5 rounded-[8px] text-xs"
          style={{ backgroundColor: 'var(--bg-badge-review)', border: '1px solid var(--border-warm)', color: 'var(--tx-badge-review)' }}
        >
          <RotateCcw size={13} style={{ flexShrink: 0 }} />
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
            ? <CheckCircle2 size={11} style={{ color: '#34d399', flexShrink: 0 }} />
            : <RotateCcw size={11} style={{ color: 'var(--tx-faint)', flexShrink: 0 }} />}
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
            <RotateCcw size={10} style={{ color: '#34d399' }} />
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
            className="text-xs transition-opacity duration-150 hover:opacity-100"
            style={{ color: 'var(--tx-tertiary)', opacity: 0.6 }}
          >
            Reset
          </button>
        ) : (
          <button
            onClick={() => setSettled(true)}
            className="text-xs px-3 py-1.5 rounded-[6px] transition-colors duration-150"
            style={{ background: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            Link reimbursement →
          </button>
        )}
      </div>
    </div>
  )
}

// ── Tip box ───────────────────────────────────────────────────────────────────

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-5 flex gap-3 px-4 py-3 rounded-[8px] text-sm"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
    >
      <Gem size={14} className="shrink-0 mt-0.5" style={{ color: '#f54e00' }} />
      <span style={{ color: 'var(--tx-secondary)' }}>{children}</span>
    </div>
  )
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ id, num, title, children }: { id: string; num: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 pb-16" style={{ borderBottom: '1px solid var(--border-warm)' }}>
      <div className="flex items-baseline gap-3 mb-6">
        <span
          className="font-mono text-[11px] font-medium shrink-0"
          style={{ color: '#f54e00', letterSpacing: '0.05em' }}
        >
          {num}
        </span>
        <h2
          className="text-[22px] font-semibold leading-tight"
          style={{ color: 'var(--tx-primary)', letterSpacing: '-0.11px' }}
        >
          {title}
        </h2>
      </div>
      {children}
    </section>
  )
}

function BodyText({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[15px] leading-relaxed mb-0" style={{ color: 'var(--tx-secondary)' }}>
      {children}
    </p>
  )
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="text-[13px] font-medium uppercase tracking-widest mt-6 mb-2"
      style={{ color: 'var(--tx-tertiary)', letterSpacing: '0.08em' }}
    >
      {children}
    </h3>
  )
}

function TransferLinkDemo({ currency }: { currency: string }) {
  return (
    <div className="w-full space-y-1.5 font-mono text-xs">
      {[
        { account: 'Current Account', desc: 'ATM Withdrawal', amount: `−${currency} 200.00`, color: '#f87171' },
        { account: 'Cash',            desc: 'ATM Withdrawal', amount: `+${currency} 200.00`, color: '#34d399' },
      ].map(({ account, desc, amount, color }) => (
        <div key={account} className="flex items-center gap-3 px-3 py-2 rounded-[6px]" style={{ background: 'var(--bg-card-alt)', border: '1px solid var(--border-warm)' }}>
          <span className="w-32 shrink-0" style={{ color: 'var(--tx-tertiary)' }}>{account}</span>
          <span className="flex-1" style={{ color: 'var(--tx-primary)' }}>{desc}</span>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-warm)', color: 'var(--tx-secondary)' }}>
            <Link2 size={10} /> Linked
          </span>
          <span style={{ color }}>{amount}</span>
        </div>
      ))}
    </div>
  )
}

function TransferDirectionDemo({ currency }: { currency: string }) {
  const rows = [
    { account: 'Barclays Current', direction: '↑ out', counterpart: 'Cash Wallet', amount: `−${currency} 200.00`, color: '#f87171' },
    { account: 'Cash Wallet',      direction: '↓ in',  counterpart: 'Barclays Current', amount: `+${currency} 200.00`, color: '#34d399' },
  ]
  return (
    <div className="w-full space-y-1.5 text-xs">
      {rows.map(({ account, direction, counterpart, amount, color }) => (
        <div key={account} className="flex items-center gap-3 px-3 py-2.5 rounded-[6px]" style={{ background: 'var(--bg-card-alt)', border: '1px solid var(--border-warm)' }}>
          <span className="w-36 shrink-0 font-medium" style={{ color: 'var(--tx-secondary)' }}>{account}</span>
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[10px] shrink-0"
            style={{ backgroundColor: 'rgba(245,158,11,0.1)', color: '#92400E' }}
          >
            {direction} · {counterpart}
          </span>
          <span className="flex-1" />
          <span className="font-mono" style={{ color, letterSpacing: '-0.275px' }}>{amount}</span>
        </div>
      ))}
    </div>
  )
}

function SplitDemoRows({ currency }: { currency: string }) {
  return (
    <div className="w-full space-y-1 font-mono text-xs">
      <div className="flex items-center gap-3 px-3 py-2 rounded-[6px]" style={{ background: 'var(--bg-card-alt)', border: '1px solid var(--border-warm)' }}>
        <span className="w-24 shrink-0" style={{ color: 'var(--tx-secondary)' }}>2024-03-15</span>
        <span className="flex-1" style={{ color: 'var(--tx-primary)' }}>IKEA STORE 0423</span>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-warm)', color: 'var(--tx-secondary)' }}>
          <Scissors size={10} /> Split ×2
        </span>
        <span style={{ color: '#f87171' }}>−{currency} 245.00</span>
      </div>
      {[
        { label: 'Home & Furniture', amount: `−${currency} 180.00` },
        { label: 'Groceries',        amount: `−${currency} 65.00` },
      ].map(({ label, amount }) => (
        <div key={label} className="flex items-center gap-3 px-3 py-1.5 ml-8 rounded-[6px]" style={{ background: 'var(--bg-page)', border: '1px solid var(--border-warm)' }}>
          <span className="flex-1" style={{ color: 'var(--tx-tertiary)' }}>{label}</span>
          <span style={{ color: 'var(--tx-secondary)' }}>{amount}</span>
        </div>
      ))}
    </div>
  )
}

function BudgetProgressDemo({ currency }: { currency: string }) {
  const items = [
    { category: 'Groceries', budget: 500, actual: 320 },
    { category: 'Dining',    budget: 200, actual: 186 },
    { category: 'Transport', budget: 150, actual: 210 },
  ]
  return (
    <div className="w-full space-y-4">
      {items.map(({ category, budget, actual }) => {
        const pct = (actual / budget) * 100
        const bar = Math.min(pct, 100)
        const color = pct > 100 ? '#f87171' : pct >= 80 ? '#fbbf24' : '#34d399'
        return (
          <div key={category}>
            <div className="flex justify-between text-xs mb-1.5">
              <span style={{ color: 'var(--tx-primary)', fontWeight: 500 }}>{category}</span>
              <span style={{ color: 'var(--tx-secondary)' }}>{currency} {actual} / {currency} {budget}</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-card-alt)', border: '1px solid var(--border-warm)' }}>
              <div className="h-full rounded-full" style={{ width: `${bar}%`, background: color, transition: 'width 0.3s' }} />
            </div>
            {pct > 100 && (
              <p className="text-[10px] mt-1" style={{ color: '#f87171' }}>Over budget by {currency} {(actual - budget).toFixed(0)}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function GuideView({ currency }: { currency: string }) {
  const [active, setActive] = useState('overview')
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observers: IntersectionObserver[] = []
    const entries = new Map<string, boolean>()

    const atBottom = () =>
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 32

    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id)
      if (!el) return
      const obs = new IntersectionObserver(
        ([entry]) => {
          entries.set(id, entry.isIntersecting)
          // Don't override when already pinned at the bottom
          if (atBottom()) return
          // Pick the topmost visible section
          const first = SECTIONS.find((s) => entries.get(s.id))
          if (first) setActive(first.id)
        },
        { rootMargin: '-20% 0px -60% 0px' }
      )
      obs.observe(el)
      observers.push(obs)
    })

    // When scrolled to the bottom, activate the last section
    const onScroll = () => {
      if (atBottom()) setActive(SECTIONS[SECTIONS.length - 1].id)
    }
    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      observers.forEach((o) => o.disconnect())
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex-1" style={{ background: 'var(--bg-page)' }}>
      <div className="max-w-5xl mx-auto px-6 md:px-10 py-10">

        {/* Page header */}
        <div className="mb-12">
          <div
            className="text-[11px] font-medium uppercase tracking-widest mb-3"
            style={{ color: '#f54e00', letterSpacing: '0.1em' }}
          >
            Field Guide
          </div>
          <h1
            className="text-[36px] font-semibold leading-[1.15] mb-3"
            style={{ color: 'var(--tx-primary)', letterSpacing: '-0.72px' }}
          >
            Everything you need<br />to know about ydb
          </h1>
          <p className="text-base max-w-xl" style={{ color: 'var(--tx-secondary)', lineHeight: 1.6 }}>
            A private, local-first bookkeeper that uses AI to extract transactions from your bank statements —
            then gets smarter every time you use it.
          </p>
        </div>

        <div className="flex gap-12 items-start">

          {/* ── Sidebar ──────────────────────────────────────────────────── */}
          <aside className="hidden lg:block shrink-0 w-44 sticky top-24">
            <nav className="space-y-0.5">
              {SECTIONS.map((s) => {
                const isActive = active === s.id
                return (
                  <button
                    key={s.id}
                    onClick={() => scrollTo(s.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-[6px] text-left transition-all duration-150 group"
                    style={{
                      background: isActive ? 'var(--bg-card-alt)' : 'transparent',
                      color: isActive ? 'var(--tx-primary)' : 'var(--tx-tertiary)',
                    }}
                  >
                    <span
                      className="font-mono text-[10px] shrink-0 transition-colors duration-150"
                      style={{ color: isActive ? '#f54e00' : 'var(--tx-faint)' }}
                    >
                      {s.num}
                    </span>
                    <span className="text-sm">{s.label}</span>
                  </button>
                )
              })}
            </nav>

            {/* Quick links */}
            <div className="mt-8 pt-6" style={{ borderTop: '1px solid var(--border-warm)' }}>
              <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--tx-faint)', letterSpacing: '0.08em' }}>
                Jump to
              </div>
              {[
                { href: '/settings', label: 'Settings' },
                { href: '/upload', label: 'Upload' },
                { href: '/ledger', label: 'Ledger' },
                { href: '/chat', label: 'Chat' },
              ].map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="flex items-center gap-1.5 py-1 text-sm transition-colors duration-150 hover:opacity-100"
                  style={{ color: 'var(--tx-tertiary)', opacity: 0.8 }}
                >
                  <ArrowRight size={12} style={{ color: '#f54e00' }} />
                  {l.label}
                </Link>
              ))}
            </div>
          </aside>

          {/* ── Main content ─────────────────────────────────────────────── */}
          <div ref={contentRef} className="flex-1 min-w-0 space-y-16">

            {/* 00 — Overview */}
            <Section id="overview" num="00" title="Overview">
              <BodyText>
                ydb is a personal accounting tool that lives entirely on your machine. There is no cloud, no
                subscription, no third-party seeing your data. You export statements from your bank, drop them
                in, and a local AI model (Qwen via Ollama) reads them and extracts every transaction.
              </BodyText>
              <DemoShell label="How it works">
                <FlowDiagram />
              </DemoShell>
              <Tip>
                All data is stored in a SQLite database file on your computer. Nothing leaves your machine.
              </Tip>
            </Section>

            {/* 01 — Accounts */}
            <Section id="accounts" num="01" title="Setting up Accounts">
              <BodyText>
                Before you upload anything, add your bank accounts in{' '}
                <Link href="/settings" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Settings</Link>.
                Each account corresponds to one bank or card. You can have as many as you need.
              </BodyText>

              <SubHeading>Account types</SubHeading>
              <div className="space-y-2 text-sm" style={{ color: 'var(--tx-secondary)' }}>
                {[
                  ['Current', 'A regular bank account with Debit and Credit columns in statements.'],
                  ['Credit', 'A credit card with a single Amount column. Positive = purchase, CR = payment back.'],
                  ['Cash', 'A cash wallet. No statement to import — you enter transactions manually as you spend.'],
                  ['Personal Loan', 'A personal loan. Opening balance is the amount outstanding — decreases as EMIs are paid.'],
                  ['Auto Loan', 'A vehicle finance loan. Same as Personal Loan — balance tracks what you still owe.'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-3">
                    <span className="w-36 shrink-0 font-medium" style={{ color: 'var(--tx-primary)' }}>{label}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>

              <DemoShell label="Example accounts">
                <AccountCardDemo currency={currency} />
              </DemoShell>

              <SubHeading>Cash & withdrawals</SubHeading>
              <BodyText>
                Create a <strong>Cash</strong> account to track physical money. When you withdraw from an ATM,
                record it as two linked transactions: a debit on your current account and a matching credit on
                the Cash account, both categorised as <strong>Transfer</strong>. Cash spending is then entered
                as regular transactions on the Cash account. This keeps your balances correct — the ATM
                withdrawal is neutral (money moved, not spent), and each cash purchase is counted once.
              </BodyText>

              <SubHeading>Opening balance</SubHeading>
              <BodyText>
                The opening balance is the account balance on the day you start tracking — the fixed
                starting point that all imported transactions build on top of.
              </BodyText>
              <BodyText>
                {'ydb computes your current balance as:'}
              </BodyText>
              <div
                className="my-4 px-4 py-3 rounded-[8px] font-mono text-sm"
                style={{ background: 'var(--bg-card-alt)', color: 'var(--tx-primary)', border: '1px solid var(--border-warm)' }}
              >
                current balance = opening balance + sum of all transactions
              </div>
              <BodyText>
                If your opening balance is wrong, the displayed balance will be off by exactly that
                amount — it is a flat offset, not a compounding error. Easy to fix: just edit the
                opening balance in Settings and everything snaps to the correct number instantly.
              </BodyText>

              <SubHeading>Where to find it</SubHeading>
              <div className="space-y-2 mt-2 text-sm" style={{ color: 'var(--tx-secondary)' }}>
                {[
                  ['Current / Credit', 'The closing balance on the last statement before your chosen start date — or the opening balance printed on the first statement you plan to import.'],
                  ['Loans', 'The outstanding principal on your first loan statement from around your start date. This is what you owed, not what you paid.'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-3">
                    <span className="w-32 shrink-0 font-medium" style={{ color: 'var(--tx-primary)' }}>{label}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>

              <SubHeading>Loan EMIs</SubHeading>
              <BodyText>
                Your loan EMIs are automatically deducted from your current account — they will appear
                in your current account statement as a regular debit. When you import those transactions,
                set the category to <strong>Transfer</strong> and they will be excluded from your
                expense totals. The loan account balance will decrease as you record each payment against it.
              </BodyText>

              <Tip>
                A good starting point is 1 January of the previous year. You get a full year of history,
                your loans are covered from the start, and import effort is manageable.
              </Tip>
            </Section>

            {/* 02 — Upload */}
            <Section id="upload" num="02" title="Uploading Statements">
              <BodyText>
                Head to{' '}
                <Link href="/upload" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Upload</Link>{' '}
                and drop in a PDF bank statement. ydb uses OCR (Tesseract) to read the text, then passes it
                to the Qwen AI model running locally via Ollama.
              </BodyText>

              <SubHeading>Format hint</SubHeading>
              <BodyText>
                Tell Qwen which statement format it is looking at. This helps it interpret the amount columns correctly.
              </BodyText>
              <DemoShell label="Format selector — click to try">
                <FormatDemo />
              </DemoShell>

              <SubHeading>Password-protected PDFs</SubHeading>
              <BodyText>
                If your statement is password-protected, ydb will ask you for the password inline — it is
                never stored anywhere.
              </BodyText>

              <SubHeading>Import order</SubHeading>
              <BodyText>
                Import statements chronologically — oldest first. Each statement builds on the previous
                balance, so order keeps your running totals accurate. Start with one month to test the
                pipeline before importing a full year.
              </BodyText>

              <Tip>
                If Qwen gets amounts wrong (e.g. all positive when some should be negative), try switching the
                format hint. Credit card statements are the most common mismatch.
              </Tip>
            </Section>

            {/* 03 — Review */}
            <Section id="review" num="03" title="Reviewing Transactions">
              <BodyText>
                After extraction, every transaction lands in a Review table before touching the ledger.
                This is your chance to check amounts, fix categories, and remove anything that looks wrong.
              </BodyText>

              <DemoShell label="Transaction row — click Commit to try">
                <div className="w-full"><TransactionRowDemo currency={currency} /></div>
              </DemoShell>

              <SubHeading>What to check</SubHeading>
              <div className="space-y-2 mt-2 text-sm" style={{ color: 'var(--tx-secondary)' }}>
                {[
                  ['Amounts', 'The amount field always shows a positive number — the sign is determined by the transaction type. Debit = expense (negative), Credit = income (positive), Transfer = depends on direction.'],
                  ['Type', 'Each transaction is classified as Debit, Credit, or Transfer using a dropdown. Patterns can set this automatically; you can change it per-row. Selecting Transfer reveals two additional fields (see below).'],
                  ['Direction & counterpart', 'When type is Transfer, choose a direction — ↑ Out (money leaving this account) or ↓ In (money arriving). You can also pick a counterpart account from your other accounts so both sides of the move are labelled clearly.'],
                  ['Descriptions', 'If a pattern matched, the display name is already set and the raw bank text appears faintly below it. You can edit the display name freely.'],
                  ['Categories', 'Qwen assigns categories based on your patterns and past transactions. Correct any that are wrong. Changing a category triggers a "Save as pattern?" strip at the bottom of the card — a quick way to lock in that mapping for future imports.'],
                  ['Duplicates', 'If you upload the same statement twice, duplicate transactions will appear. Delete the extras.'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-3">
                    <span className="w-36 shrink-0 font-medium" style={{ color: 'var(--tx-primary)' }}>{label}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>

              <Tip>
                Use the bulk commit button to commit everything at once once you have reviewed the batch.
                You can always revert individual transactions from the Ledger later.
              </Tip>
            </Section>

            {/* 04 — Ledger */}
            <Section id="ledger" num="04" title="The Ledger">
              <BodyText>
                The{' '}
                <Link href="/ledger" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Ledger</Link>{' '}
                is the permanent record of all your transactions. Once committed, a transaction appears here
                and contributes to your account balances and dashboard figures.
              </BodyText>

              <SubHeading>Transaction statuses</SubHeading>
              <DemoShell label="Status badges">
                <StatusBadgeDemo />
              </DemoShell>

              <SubHeading>Editing & reverting</SubHeading>
              <BodyText>
                Click <strong>Edit</strong> on any row to open an inline edit form. The amount field always
                shows a positive number — the sign is derived from the transaction type. For transfers,
                a <strong>Direction</strong> dropdown (↑ Out / ↓ In) and a <strong>counterpart account</strong>{' '}
                picker also appear so you can record which account the money moved to or from.
                You can also revert a committed transaction back to Review status if something needs correcting.
              </BodyText>

              <SubHeading>Manual transactions</SubHeading>
              <BodyText>
                Not everything comes from a PDF. Cash spending, manual corrections, or one-off entries
                can be added directly from the Ledger. Click the <strong>+ New transaction</strong> button
                in the filter bar — a compact form appears with fields for date, description, amount, type,
                category, account, and status. Hit <strong>Add</strong> or press Enter to save it directly
                to the ledger (bypassing the review table). This is the primary way to log expenses on a
                Cash account.
              </BodyText>

              <SubHeading>Filtering</SubHeading>
              <BodyText>
                Filter by account, date range, category, or status using the controls at the top of the ledger.
                The row count updates live.
              </BodyText>

              <SubHeading>Transfers</SubHeading>
              <BodyText>
                When money moves between two of your own accounts (e.g. an ATM withdrawal from Current to Cash,
                or a credit card payment), set the transaction type to <strong>Transfer</strong>. The edit form
                then shows two extra fields: <strong>Direction</strong> (↑ Out for money leaving, ↓ In for money
                arriving) and a <strong>counterpart account</strong> dropdown listing your other accounts.
                Setting both makes every transfer self-documenting — the row chip shows{' '}
                <em>↑ out · Account Name</em> or <em>↓ in · Account Name</em> at a glance.
              </BodyText>
              <DemoShell label="Transfer direction chip — how it looks in the ledger">
                <TransferDirectionDemo currency={currency} />
              </DemoShell>
              <BodyText>
                You can also hard-link both sides of the same move using the <strong>link icon</strong> on
                either row — ydb will suggest candidates with a matching amount and nearby date. Once linked,
                a chain badge appears on both rows.
              </BodyText>
              <DemoShell label="Linked transfer pair">
                <TransferLinkDemo currency={currency} />
              </DemoShell>

              <SubHeading>Split transactions</SubHeading>
              <BodyText>
                If a single transaction spans multiple categories — a supermarket run that includes
                groceries <em>and</em> household items — you can split it into legs. Click the{' '}
                <strong>scissors icon</strong> on any row, add a leg per category, and adjust amounts so
                they sum to the original total. The parent row remains in the ledger; its category cell
                shows a <strong>Split ×N</strong> badge you can expand to see each leg inline.
              </BodyText>
              <DemoShell label="Split transaction — parent + legs">
                <SplitDemoRows currency={currency} />
              </DemoShell>

              <SubHeading>CSV export</SubHeading>
              <BodyText>
                Click the <Download size={13} style={{ display: 'inline', verticalAlign: 'middle' }} />{' '}
                <strong>Export</strong> button in the filter bar to download the current filtered view as a CSV.
                All columns are included — date, description, raw description, amount, type, category, account, status, notes.
              </BodyText>

              <Tip>
                Transfer transactions (moving money between your own accounts) have type{' '}
                <strong>Transfer</strong> and are excluded from income/expense totals on the dashboard.
                Set the direction and counterpart account on each transfer so you can see at a glance
                where money went. Use a pattern to automatically stamp the type at import time,
                then fine-tune direction and counterpart in the edit form.
              </Tip>
            </Section>

            {/* 05 — Categories & AI */}
            <Section id="categories" num="05" title="Categories & AI Training">
              <BodyText>
                Categories help you understand where your money goes. ydb ships without any — you define
                them to match your life. Qwen then assigns categories automatically as it reads new statements.
              </BodyText>

              <SubHeading>Categories</SubHeading>
              <BodyText>
                Add categories in Settings. Each one gets a colour automatically assigned from a
                curated palette — all colours meet WCAG AA contrast standards.
              </BodyText>
              <DemoShell label="Example categories">
                <CategoryPillsDemo />
              </DemoShell>

              <SubHeading>Patterns — teaching Qwen</SubHeading>
              <BodyText>
                Patterns are rules that match raw bank statement text and apply a set of outputs: a
                human-readable <strong>display name</strong>, a <strong>category</strong>, and optionally
                a <strong>transaction type</strong> override. They run at import time — before the review
                table — so you see friendly names immediately. Patterns take priority over Qwen's guesses.
              </BodyText>
              <BodyText>
                The raw bank text is always preserved as a secondary line beneath the display name,
                so you can still search by it and audit what was matched.
              </BodyText>
              <DemoShell label="Patterns — raw text → display name, category, and type">
                <div className="w-full"><PatternDemo /></div>
              </DemoShell>

              <SubHeading>Match types</SubHeading>
              <div className="space-y-2 mt-2 text-sm" style={{ color: 'var(--tx-secondary)' }}>
                {[
                  ['~ contains',    'Pattern appears anywhere in the raw bank text. Default. Case-insensitive.'],
                  ['^ starts-with', 'Raw text must begin with the pattern. Useful when banks prefix with a code.'],
                  ['$ ends-with',   'Raw text must end with the pattern.'],
                  ['= exact',       'Full raw text must equal the pattern exactly (case-insensitive).'],
                  ['.* regex',      'Pattern is a regular expression. Use for complex cases. Validated on save.'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-3">
                    <span className="w-28 shrink-0 font-mono text-xs pt-0.5" style={{ color: 'var(--tx-primary)' }}>{label}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>

              <SubHeading>Direction &amp; amount filters</SubHeading>
              <BodyText>
                <strong>Direction</strong> is an input gate — scope a pattern to <strong>debit-only</strong> or <strong>credit-only</strong> so the
                same raw text maps differently depending on which way money flows.
                For example: <em>AMAZON</em> debit → Shopping, <em>AMAZON RETURN</em> credit → Refunds.
              </BodyText>
              <BodyText>
                Amount bounds (<strong>min</strong> / <strong>max</strong>) narrow a pattern to a specific size range.
                Add them under <strong>Advanced options</strong> when creating a pattern.
                Example: <em>AMAZON</em> debit, max 500 → Shopping; <em>AMAZON</em> debit, min 500 → Electronics.
              </BodyText>

              <SubHeading>Set type</SubHeading>
              <BodyText>
                <strong>Set type</strong> is an output assignment — when a pattern matches, the transaction's
                type is stamped as Debit, Credit, or Transfer. Use this for transactions whose type
                is always known from the description, e.g. <em>CREDIT CARD PAYMENT</em> → Transfer.
                If left as "Don't override", the type is inferred from the amount sign.
              </BodyText>

              <SubHeading>Priority</SubHeading>
              <BodyText>
                When multiple rules could match the same transaction, the one with the <strong>lowest
                priority number</strong> wins. All rules default to priority 0 — if you need a rule
                to take precedence, set it to a negative number or adjust others upward.
                Edit the priority inline in the Settings table; the list reorders immediately.
              </BodyText>

              <SubHeading>Multiple patterns per vendor</SubHeading>
              <BodyText>
                Banks render the same merchant inconsistently — NETFLIX.COM, NFLX*SERVICE, NETFLIX INTL.
                Add all variants under the same display name: patterns sharing a name are grouped
                together in Settings. Click <strong>+ Add pattern</strong> on a group to attach
                another raw-text variant without retyping the name and category.
              </BodyText>
              <BodyText>
                You can also use multiple patterns per vendor for granular category splits — e.g. Careem
                with <em>CAREEM EATS</em> → Dining and <em>CAREEM RIDE</em> → Transport. Each pattern
                can have its own direction, amount bounds, category, and type override.
              </BodyText>

              <SubHeading>Testing patterns</SubHeading>
              <BodyText>
                Hover any pattern row and click the <FlaskConical size={12} style={{ display: 'inline', verticalAlign: 'middle', marginInline: 2 }} />{' '}
                icon to run a live test against your committed transactions. The test panel matches
                against the raw bank text (<em>originalDescription</em>) — the same field patterns
                use at import time — and shows a secondary line with the raw text for each hit.
              </BodyText>

              <SubHeading>Auto-suggestions</SubHeading>
              <BodyText>
                Whenever you change a category — in the Review table or the Ledger — a{' '}
                <strong>Save as pattern?</strong> strip appears at the bottom of the row. It is
                pre-filled with the raw bank text as the pattern and your chosen category. Edit the
                pattern or vendor name if needed, pick a match type, then hit{' '}
                <strong>Save Pattern</strong>. The strip can be dismissed with ×; once dismissed it
                won&apos;t re-appear for that row in the same session. Direction is inferred
                automatically from the transaction amount — debits create debit-scoped patterns,
                credits create credit-scoped ones.
              </BodyText>

              <SubHeading>Learned patterns</SubHeading>
              <BodyText>
                Beyond explicit patterns, Qwen also learns from your committed transactions. The more
                you commit and correct, the better its categorisation gets — automatically.
              </BodyText>

              <Tip>
                Start with your most frequent vendors (supermarkets, subscriptions, transport) as
                explicit patterns. Use <strong>Set type</strong> for anything that's always a Transfer
                (credit card payments, inter-account moves). Let learned patterns fill in the rest over time.
              </Tip>
            </Section>

            {/* 06 — Budgets */}
            <Section id="budgets" num="06" title="Budgets">
              <BodyText>
                Budgets let you set a monthly spending limit per category. Once set, the Dashboard shows
                a live progress bar for each budget — green while you're on track, amber when you're
                approaching the limit (80 %), and red if you've gone over.
              </BodyText>

              <DemoShell label="Budget progress — current month">
                <BudgetProgressDemo currency={currency} />
              </DemoShell>

              <SubHeading>Setting budgets</SubHeading>
              <BodyText>
                Go to{' '}
                <Link href="/settings" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Settings</Link>{' '}
                and find the <strong>Budgets</strong> card. Pick a category, enter a monthly limit,
                and click Add. Each category can have at most one budget — adding a duplicate replaces
                the existing limit.
              </BodyText>

              <Tip>
                Budgets only count the <em>current calendar month</em> regardless of the date range
                selected on the Dashboard. This keeps the progress bars meaningful day-to-day.
              </Tip>
            </Section>

            {/* 07 — Dashboard */}
            <Section id="dashboard" num="07" title="Dashboard">
              <BodyText>
                The{' '}
                <Link href="/dashboard" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Dashboard</Link>{' '}
                gives you a financial overview across a date range. All figures are computed
                from committed and reconciled transactions only — Review-status transactions are excluded.
              </BodyText>

              <DemoShell label="Summary statistics">
                <StatCardsDemo currency={currency} />
              </DemoShell>

              <SubHeading>What's on the dashboard</SubHeading>
              <div className="space-y-2 mt-2 text-sm" style={{ color: 'var(--tx-secondary)' }}>
                {[
                  ['Account balances', 'Opening balance + all committed transactions = current balance for each account.'],
                  ['Net Worth',        'Assets (current accounts) minus liabilities (credit cards + loans), with a trend line using the cash-flow period.'],
                  ['Monthly chart',    'Income vs expenses bar chart across the selected date range.'],
                  ['Category breakdown', 'Donut chart showing your biggest expense categories.'],
                  ['Category trends',  'Line chart showing how each category changes month over month.'],
                  ['Top transactions', 'The 10 largest transactions by absolute amount in the period.'],
                  ['Cash flow table',  'Month-by-month opening balance, income, expenses, and closing balance.'],
                  ['Budgets',          'Current-month spend vs monthly limit for each budget you have set up. See section 06.'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-3">
                    <span className="w-44 shrink-0 font-medium" style={{ color: 'var(--tx-primary)' }}>{label}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>

              <SubHeading>Filtering</SubHeading>
              <BodyText>
                Use the date range picker at the top to narrow the period. If you have accounts in multiple
                currencies, use the currency selector to switch between views — each currency is shown
                independently.
              </BodyText>

              <Tip>
                Transfer transactions are automatically excluded from all income/expense calculations.
                Only moves between external accounts (income, expenses) count.
              </Tip>
            </Section>

            {/* 08 — Recurring */}
            <Section id="recurring" num="08" title="Recurring Transactions">
              <BodyText>
                ydb can automatically detect recurring charges in your transaction history —
                subscriptions, standing orders, insurance premiums, loan EMIs — anything that
                appears with a consistent amount on a roughly monthly interval.
              </BodyText>

              <SubHeading>How detection works</SubHeading>
              <BodyText>
                ydb groups your committed transactions by description prefix, then looks for groups
                where the same amount (within ±10 %) appears at least three times with an average
                gap of 25–40 days. Matches are surfaced in{' '}
                <Link href="/settings" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Settings</Link>{' '}
                under <strong>Recurring Transactions</strong>, showing the estimated monthly cost,
                occurrence count, and when the last one landed.
              </BodyText>

              <SubHeading>What to do with them</SubHeading>
              <BodyText>
                Use the list as a prompt to create vendor rules or budgets for any recurring charge
                you haven't already categorised. It's also a quick way to spot forgotten subscriptions.
              </BodyText>

              <Tip>
                The list refreshes on every page load — it reads your live transaction data, so
                accuracy improves as you import more history.
              </Tip>
            </Section>

            {/* 09 — Chat */}
            <Section id="chat" num="09" title="Chat">
              <BodyText>
                The{' '}
                <Link href="/chat" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Chat</Link>{' '}
                page lets you ask plain-English questions about your transactions and get a direct answer —
                no filters to configure, no charts to interpret. Just ask.
              </BodyText>

              <DemoShell label="How a question becomes an answer">
                <ChatFlowDiagram />
              </DemoShell>

              <SubHeading>How it works</SubHeading>
              <BodyText>
                Under the hood, Chat uses a two-step process. Your question is sent to a local AI model
                (Qwen by default), which writes a SQL query against your local database. That query runs
                on a read-only database connection — it can never modify your data. The results are then
                narrated back as a plain-English answer. No data leaves your device at any point.
              </BodyText>

              <DemoShell label="Example conversation — click Show SQL to inspect">
                <ChatConversationDemo currency={currency} />
              </DemoShell>

              <SubHeading>Conversation history</SubHeading>
              <BodyText>
                Each conversation is saved as a named session. The left sidebar lists all your past
                chats — click one to resume it, or press <strong>New Chat</strong> to start fresh.
                Sessions are automatically titled from your first message. Context from earlier
                messages in the same session is carried forward, so you can ask follow-up questions
                without repeating yourself.
              </BodyText>

              <SubHeading>Show SQL</SubHeading>
              <BodyText>
                Every assistant response has a <strong>Show SQL</strong> toggle beneath it. Use this to
                verify the query that produced the answer — if a number looks off, the SQL will tell you
                exactly why.
              </BodyText>

              <SubHeading>What it can answer</SubHeading>
              <div className="space-y-2 mt-2 text-sm" style={{ color: 'var(--tx-secondary)' }}>
                {[
                  ['Totals',       'How much did I spend last month? What is my total income this year?'],
                  ['Categories',   'What were my top 5 spending categories? How much on groceries?'],
                  ['Trends',       'Which month did I spend the most? How has dining changed over time?'],
                  ['Transactions', `Show me all transactions over ${currency} 500. What did I spend at Tesco?`],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-3">
                    <span className="w-28 shrink-0 font-medium" style={{ color: 'var(--tx-primary)' }}>{label}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>

              <Tip>
                Chat runs on a read-only database connection — it is physically unable to modify your data,
                even if the AI generates a bad query. If an answer looks wrong, check the SQL and try
                rephrasing with more specific date or category terms.
              </Tip>
            </Section>

            {/* 10 — Reimbursements */}
            <Section id="reimbursements" num="10" title="Reimbursements">
              <BodyText>
                Some expenses are temporary — you pay upfront and get part or all of it back later.
                Insurance claims are the classic example: you settle a medical bill today and the insurer
                credits you 10–15 days later. ydb tracks these as a matched pair so your books stay honest:
                the expense is recorded in full, and when the credit arrives you link it. The row then
                shows your actual out-of-pocket cost.
              </BodyText>

              <SubHeading>Step 1 — Flag the expense</SubHeading>
              <BodyText>
                Edit the transaction in the{' '}
                <Link href="/ledger" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Ledger</Link>.
                In the Notes cell, check the <strong>Reimbursable</strong> checkbox and type who owes
                you — for example <em>Insurance</em> or <em>Employer</em>. Save the row. The transaction
                now carries a{' '}
                <RotateCcw size={12} style={{ display: 'inline', verticalAlign: 'middle', marginInline: 2 }} />{' '}
                icon and appears in the pending reimbursements banner at the top of the ledger.
              </BodyText>

              <SubHeading>Step 2 — Link the settlement</SubHeading>
              <BodyText>
                When the credit appears in your account, hover the flagged expense row and click the{' '}
                <RotateCcw size={12} style={{ display: 'inline', verticalAlign: 'middle', marginInline: 2 }} />{' '}
                icon in the actions column. A modal opens showing all available credit transactions,
                sorted by closest amount match. Select the one that settles this expense. The row
                updates immediately: the gross amount stays, the net appears beneath it, and the row
                gains a{' '}
                <CheckCircle2 size={12} style={{ display: 'inline', verticalAlign: 'middle', marginInline: 2, color: '#34d399' }} />{' '}
                icon to confirm the link.
              </BodyText>

              <DemoShell label="Reimbursement lifecycle — click to link">
                <ReimbursementDemo currency={currency} />
              </DemoShell>

              <SubHeading>Pending reimbursements banner</SubHeading>
              <BodyText>
                The top of the Ledger shows a banner whenever you have unsettled reimbursable expenses.
                It displays the count and total amount outstanding. Click it to toggle a filter that shows
                only pending reimbursements — useful when you are chasing multiple claims at once.
              </BodyText>

              <SubHeading>Partial reimbursements</SubHeading>
              <BodyText>
                Insurance often covers less than the full amount — an 80 % policy on a{' '}
                {currency} 500 bill pays back {currency} 400. Link whatever credit arrives and the net
                amount updates to reflect your actual cost ({currency} 100 out of pocket in that example).
                If a claim is denied entirely, the expense stays pending in the banner indefinitely until
                you either link a credit or manually uncheck the Reimbursable flag.
              </BodyText>

              <Tip>
                Reimbursements are not counted as income. The credit is a cost correction — linking it
                reduces your net expense without inflating your income or savings rate figures.
              </Tip>
            </Section>

            {/* 11 — Backups */}
            <Section id="backups" num="11" title="Backups">
              <BodyText>
                ydb stores everything in a single SQLite file on your machine. Backups are plain copies
                of that file — portable, self-contained, and restorable without any tooling beyond
                replacing the file.
              </BodyText>

              <SubHeading>Automatic backups</SubHeading>
              <BodyText>
                A backup is created automatically each time the app server starts, but at most once per
                day. If you leave the app running continuously, trigger a manual backup before
                importing a large batch of statements or making bulk edits.
              </BodyText>

              <SubHeading>Manual backups</SubHeading>
              <BodyText>
                Open{' '}
                <Link href="/settings" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Settings</Link>{' '}
                and scroll to the <strong>Backups</strong> card. Click <strong>Back up now</strong> to
                snapshot the database immediately. The new entry appears at the top of the list with its
                timestamp and file size.
              </BodyText>

              <SubHeading>Downloading a backup</SubHeading>
              <BodyText>
                Each backup has a{' '}
                <Download size={12} style={{ display: 'inline', verticalAlign: 'middle', marginInline: 2 }} />{' '}
                <strong>Download</strong> link. The file is a standard SQLite database — open it with
                any SQLite viewer, or restore by replacing{' '}
                <code
                  className="font-mono text-[13px] px-1 py-0.5 rounded"
                  style={{ background: 'var(--bg-card-alt)', color: 'var(--tx-primary)' }}
                >
                  prisma/dev.db
                </code>{' '}
                in the project directory and restarting the app.
              </BodyText>

              <SubHeading>Retention</SubHeading>
              <BodyText>
                The last 14 backups are kept. Older ones are pruned automatically when a new backup is
                created. With daily auto-backups that gives you a two-week rolling window.
              </BodyText>

              <Tip>
                Backups are excluded from git. Store downloaded snapshots somewhere safe — cloud
                storage, an external drive — if you want longer-term coverage beyond the 14-backup
                window.
              </Tip>
            </Section>

            {/* 12 — Settings */}
            <Section id="settings" num="12" title="Settings">
              <BodyText>
                <Link href="/settings" className="underline underline-offset-2" style={{ color: 'var(--tx-primary)' }}>Settings</Link>{' '}
                is the control panel for everything that isn't a transaction. Accounts, categories, patterns,
                budgets, backups, and preferences all live here — along with a few housekeeping tools.
              </BodyText>

              <SubHeading>Preferences</SubHeading>
              <BodyText>
                Set your <strong>base currency</strong> — the currency used across dashboard totals,
                the chat interface, and any display that shows a single aggregate figure. If you have
                accounts in multiple currencies, this determines which one drives the summary views.
                Individual account balances always display in their own currency.
              </BodyText>

              <SubHeading>Import history</SubHeading>
              <BodyText>
                Every PDF upload is logged: filename, account, transaction count, and timestamp.
                The log is read-only — use it to check when you last imported a statement or verify
                that a particular file was processed. It does not record individual transactions,
                only the batch-level event.
              </BodyText>

              <SubHeading>Danger Zone</SubHeading>
              <BodyText>
                The Danger Zone lets you selectively wipe data — useful when starting fresh after a
                test import, or clearing out a specific data type without touching the rest.
                Each option is scoped precisely:
              </BodyText>
              <div className="mt-2 rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--bg-card-alt)', borderBottom: '1px solid var(--border-warm)' }}>
                      <th className="text-left px-4 py-2.5 font-medium w-36" style={{ color: 'var(--tx-secondary)' }}>Option</th>
                      <th className="text-left px-4 py-2.5 font-medium" style={{ color: 'var(--tx-secondary)' }}>What gets removed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['Transactions',    'Removes all ledger entries. Accounts, categories, and patterns are untouched.'],
                      ['Import History',  'Clears the upload log only. Transactions already committed to the ledger are kept.'],
                      ['Accounts',        'Removes all accounts — and, because transactions belong to accounts, also clears all transactions and import history.'],
                      ['Categories',      'Removes all categories and their associated budget targets.'],
                      ['Patterns',        'Removes all vendor rules. Past transactions are unaffected; future imports will not match.'],
                      ['Chat History',    'Deletes all AI assistant conversations. Transaction data is untouched.'],
                    ].map(([label, desc], i, arr) => (
                      <tr key={label} style={{ borderTop: '1px solid var(--border-warm)' }}>
                        <td className="px-4 py-2.5 font-medium align-top" style={{ color: 'var(--tx-primary)' }}>{label}</td>
                        <td className="px-4 py-2.5 align-top" style={{ color: 'var(--tx-secondary)' }}>{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <BodyText>
                All Danger Zone actions require you to type <strong>DELETE</strong> before proceeding.
                They are irreversible — make sure you have a recent backup first.
              </BodyText>

              <Tip>
                <AlertTriangle size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4, color: '#f54e00' }} />
                The Accounts option is the most destructive — it cascades to transactions and import history.
                Use it only when you want to start completely fresh. For a less drastic reset, clear
                transactions only and keep your account structure intact.
              </Tip>
            </Section>

          </div>
        </div>
      </div>
    </div>
  )
}
