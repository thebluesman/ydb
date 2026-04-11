'use client'

import { AlertTriangle } from 'lucide-react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        padding: '40px 20px',
      }}
    >
      <div
        style={{
          maxWidth: 420,
          width: '100%',
          textAlign: 'center',
          padding: '40px 32px',
          borderRadius: 12,
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-warm)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <AlertTriangle
          size={36}
          style={{ color: 'var(--tx-error)', margin: '0 auto 16px' }}
        />
        <h2
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.11px',
            color: 'var(--tx-primary)',
            marginBottom: 8,
          }}
        >
          Something went wrong
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--tx-secondary)',
            lineHeight: 1.5,
            marginBottom: 24,
          }}
        >
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={reset}
          style={{
            padding: '10px 20px',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            backgroundColor: 'var(--bg-btn)',
            color: 'var(--tx-primary)',
            border: '1px solid var(--border-warm)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
