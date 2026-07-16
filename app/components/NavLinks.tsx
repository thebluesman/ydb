'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings, Menu, X } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/ledger',    label: 'Ledger'    },
  { href: '/upload',    label: 'Upload'    },
  { href: '/chat',      label: 'Chat'      },
  { href: '/guide',     label: 'Guide'     },
]

export function NavLinks() {
  const pathname = usePathname()

  return (
    <nav className="hidden md:flex gap-1 text-sm flex-1">
      {LINKS.map(({ href, label }) => {
        const active = pathname?.startsWith(href) ?? false
        return (
          <Link
            key={href}
            href={href}
            className="nav-link"
            style={{
              padding: '4px 10px',
              borderRadius: '6px',
              transition: 'background 0.15s, color 0.15s',
              backgroundColor: active ? 'var(--bg-nav-active)' : 'transparent',
              color: active ? 'var(--tx-nav-active)' : 'var(--tx-secondary)',
              fontWeight: active ? 600 : 500,
            }}
          >
            {label}
          </Link>
        )
      })}
    </nav>
  )
}

export function ConfigLink() {
  const pathname = usePathname()
  const active = pathname?.startsWith('/settings') ?? false

  return (
    <Link
      href="/settings"
      aria-label="Settings"
      className="hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-colors duration-150"
      style={{
        backgroundColor: active ? 'var(--bg-nav-active)' : 'var(--bg-btn)',
        border: '1px solid var(--border-warm)',
        color: active ? 'var(--tx-nav-active)' : 'var(--tx-secondary)',
        fontWeight: 600,
      }}
    >
      <Settings size={13} />
      <span>Settings</span>
    </Link>
  )
}

/** Below `md`, the top nav collapses into this single hamburger menu covering
 *  every link — including Settings, which otherwise only lives in ConfigLink. */
export function MobileNav() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const items = [...LINKS, { href: '/settings', label: 'Settings' }]

  return (
    <div className="md:hidden">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="flex items-center justify-center rounded-[6px] transition-colors duration-150"
            style={{ width: 36, height: 36, color: 'var(--tx-primary)' }}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            style={{
              zIndex: 9999,
              minWidth: 180,
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-warm)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-card)',
              padding: 6,
              outline: 'none',
              animation: 'calendarIn 120ms cubic-bezier(0.22,1,0.36,1)',
            }}
          >
            <nav className="flex flex-col gap-0.5">
              {items.map(({ href, label }) => {
                const active = pathname?.startsWith(href) ?? false
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    className="text-sm"
                    style={{
                      padding: '9px 12px',
                      borderRadius: 6,
                      backgroundColor: active ? 'var(--bg-nav-active)' : 'transparent',
                      color: active ? 'var(--tx-nav-active)' : 'var(--tx-primary)',
                      fontWeight: active ? 600 : 500,
                    }}
                  >
                    {label}
                  </Link>
                )
              })}
            </nav>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
