'use client'

import Link from 'next/link'
import { Check } from 'lucide-react'

type Step = { label: string; done: boolean; href: string; cta: string }

/** First-run experience (Phase U5 / Phase 7 item 8): shown only on a truly
 *  empty database (no accounts and no transactions yet) so a new user has a
 *  guided path instead of a wall of empty charts. Each step links straight to
 *  the page that completes it. */
export function OnboardingCard({
  hasAccounts,
  hasTransactions,
  hasBudgets,
}: {
  hasAccounts: boolean
  hasTransactions: boolean
  hasBudgets: boolean
}) {
  const steps: Step[] = [
    { label: 'Create an account', done: hasAccounts, href: '/settings#accounts', cta: 'Add account' },
    { label: 'Import a statement', done: hasTransactions, href: '/upload', cta: 'Upload' },
    { label: 'Set a budget', done: hasBudgets, href: '/settings#budgets', cta: 'Set budgets' },
  ]

  return (
    <div
      className="p-6 rounded-[8px]"
      style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
        Get started
      </p>
      <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>
        Three steps to go from an empty tracker to a categorized ledger.
      </p>
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.label} className="flex items-center gap-3">
            <span
              className="flex items-center justify-center shrink-0 rounded-full text-xs font-semibold"
              style={{
                width: 24,
                height: 24,
                backgroundColor: step.done ? 'var(--bg-badge-committed)' : 'var(--bg-card-alt)',
                color: step.done ? 'var(--tx-badge-committed)' : 'var(--tx-tertiary)',
                border: step.done ? 'none' : '1px solid var(--border-warm)',
              }}
            >
              {step.done ? <Check size={14} /> : i + 1}
            </span>
            <span
              className="text-sm flex-1"
              style={{
                color: step.done ? 'var(--tx-faint)' : 'var(--tx-primary)',
                textDecoration: step.done ? 'line-through' : 'none',
              }}
            >
              {step.label}
            </span>
            {!step.done && (
              <Link
                href={step.href}
                className="btn px-3 py-1 text-xs rounded-[6px] transition-colors duration-150"
                style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
              >
                {step.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
