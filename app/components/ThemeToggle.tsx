'use client'

import { useEffect, useState } from 'react'
import { Sun, Moon } from 'lucide-react'

export function ThemeToggle() {
  const [dark, setDark] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  // Render a placeholder with the same dimensions to avoid layout shift
  if (!mounted) {
    return <div className="w-16 h-7" />
  }

  return (
    <button
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-colors duration-150 hover:text-accent"
      style={{
        backgroundColor: 'var(--bg-btn)',
        border: '1px solid var(--border-warm)',
        color: 'var(--tx-secondary)',
      }}
    >
      {dark ? <Sun size={13} /> : <Moon size={13} />}
      <span>{dark ? 'Light' : 'Dark'}</span>
    </button>
  )
}
