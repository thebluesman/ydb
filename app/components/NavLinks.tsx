'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings } from 'lucide-react'

const LINKS = [
  { href: '/ledger',  label: 'Ledger'  },
  { href: '/chat',    label: 'Chat'    },
  { href: '/upload',  label: 'Upload'  },
  { href: '/guide',   label: 'Guide'   },
]

export function NavLinks() {
  const pathname = usePathname()

  return (
    <nav className="flex gap-1 text-sm flex-1">
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
      aria-label="Config"
      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-colors duration-150"
      style={{
        backgroundColor: active ? 'var(--bg-nav-active)' : 'var(--bg-btn)',
        border: '1px solid var(--border-warm)',
        color: active ? 'var(--tx-nav-active)' : 'var(--tx-secondary)',
        fontWeight: 600,
      }}
    >
      <Settings size={13} />
      <span>Config</span>
    </Link>
  )
}
