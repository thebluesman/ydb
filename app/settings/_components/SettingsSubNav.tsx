'use client'

import { useEffect, useState } from 'react'

const SECTIONS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'categories', label: 'Categories' },
  { id: 'rules', label: 'Rules' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'ynab', label: 'YNAB' },
  { id: 'imports', label: 'Imports' },
  { id: 'backups', label: 'Backups' },
  { id: 'danger-zone', label: 'Danger Zone' },
]

// Below this many px from the viewport top (roughly the sticky header +
// this nav's own height), a section counts as "reached". Untracked cards
// (Preferences, Reconciliation) sit between some of the anchored ones, so an
// IntersectionObserver band can go stale while scrolled through a gap with
// nothing tracked visible — walking every section's `getBoundingClientRect()`
// on scroll instead always finds the last one reached, gap or not.
const ACTIVE_OFFSET = 140

/** Sticky in-page section nav for Settings (Phase U5) — anchor-scrolls to
 *  each card and tracks which one is currently in view as the user scrolls,
 *  so the active pill follows scroll position, not just clicks. Sits below the
 *  global sticky header (top-14 ≈ its ~56px height) so both stay visible. */
export function SettingsSubNav() {
  const [active, setActive] = useState<string>(SECTIONS[0].id)

  useEffect(() => {
    const elements = SECTIONS
      .map((s) => ({ id: s.id, el: document.getElementById(s.id) }))
      .filter((s): s is { id: string; el: HTMLElement } => s.el != null)
    if (elements.length === 0) return

    const onScroll = () => {
      let current = elements[0].id
      for (const { id, el } of elements) {
        if (el.getBoundingClientRect().top <= ACTIVE_OFFSET) current = id
      }
      setActive(current)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-14 z-10 bg-surface-200 py-2 flex items-center gap-1 overflow-x-auto"
      style={{ borderBottom: '1px solid var(--border-warm)' }}
    >
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="btn px-2.5 py-1 text-xs rounded-full whitespace-nowrap transition-colors duration-150"
          style={{
            backgroundColor: active === s.id ? 'var(--bg-selected)' : 'transparent',
            color: active === s.id ? 'var(--tx-selected)' : 'var(--tx-secondary)',
          }}
        >
          {s.label}
        </a>
      ))}
    </nav>
  )
}
