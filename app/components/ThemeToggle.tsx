'use client'

import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor } from 'lucide-react'

type Theme = 'light' | 'dark' | 'system'

function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

const NEXT: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' }
const ICON = { light: Sun, dark: Moon, system: Monitor }
const LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system'
    const stored = localStorage.getItem('theme')
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  })
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration-safe mount flag, not derived render state
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    document.documentElement.classList.toggle('dark', resolveDark(theme))
    if (theme !== 'system') return
    // Live-follow the OS preference while `system` is active, rather than
    // snapshotting matchMedia() once — matches the theme-init script's logic.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => document.documentElement.classList.toggle('dark', mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme, mounted])

  // Render a placeholder with the same dimensions to avoid layout shift
  if (!mounted) {
    return <div className="w-16 h-7" />
  }

  const next = NEXT[theme]
  const Icon = ICON[theme]

  return (
    <button
      onClick={() => { setTheme(next); localStorage.setItem('theme', next) }}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]} mode`}
      className="btn flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-colors duration-150 hover:text-accent"
      style={{
        backgroundColor: 'var(--bg-btn)',
        border: '1px solid var(--border-warm)',
        color: 'var(--tx-secondary)',
      }}
    >
      <Icon size={14} />
      <span>{LABEL[theme]}</span>
    </button>
  )
}
