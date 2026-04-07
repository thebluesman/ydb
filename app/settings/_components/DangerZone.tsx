'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export function DangerZone() {
  const router = useRouter()
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'clearing'>('idle')
  const [countdown, setCountdown] = useState(5)

  // Auto-reset confirm state after 5 s if user doesn't click again
  useEffect(() => {
    if (phase !== 'confirm') return
    setCountdown(5)
    const interval = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) { clearInterval(interval); setPhase('idle'); return 5 }
        return n - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [phase])

  const handleClick = async () => {
    if (phase === 'idle') { setPhase('confirm'); return }
    if (phase === 'confirm') {
      setPhase('clearing')
      await fetch('/api/clear-data', { method: 'DELETE' })
      router.refresh()
      setPhase('idle')
    }
  }

  const label =
    phase === 'clearing' ? 'Clearing…' :
    phase === 'confirm'  ? `Confirm — clears everything (${countdown}s)` :
    'Clear All Data'

  return (
    <div
      className="p-6 rounded-[8px]"
      style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
    >
      <h2 className="text-[22px] font-semibold mb-1" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
        Danger Zone
      </h2>
      <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
        Deletes all accounts, transactions, categories, and vendor rules. Settings are preserved. Cannot be undone.
      </p>
      <button
        onClick={handleClick}
        disabled={phase === 'clearing'}
        className="px-[12px] py-[7px] text-sm rounded-[8px] transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          backgroundColor: phase === 'confirm' ? 'var(--tx-error)' : 'var(--bg-notify-error)',
          color: phase === 'confirm' ? '#fff' : 'var(--tx-notify-error)',
          border: '1px solid var(--border-warm)',
        }}
      >
        {label}
      </button>
      {phase === 'confirm' && (
        <button
          onClick={() => setPhase('idle')}
          className="ml-3 text-sm transition-colors duration-150"
          style={{ color: 'var(--tx-tertiary)' }}
        >
          Cancel
        </button>
      )}
    </div>
  )
}
