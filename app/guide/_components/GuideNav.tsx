'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

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

export function GuideNav() {
  const [active, setActive] = useState('overview')

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
    <aside className="hidden lg:block shrink-0 w-44 sticky top-24">
      <nav className="space-y-0.5">
        {SECTIONS.map((s) => {
          const isActive = active === s.id
          return (
            <button
              key={s.id}
              onClick={() => scrollTo(s.id)}
              className="btn w-full flex items-center gap-2.5 px-3 py-1.5 rounded-[6px] text-left transition-all duration-150 group"
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
  )
}
