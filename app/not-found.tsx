import Link from 'next/link'

export default function NotFound() {
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
        <p
          style={{
            fontSize: 48,
            fontWeight: 700,
            color: 'var(--tx-tertiary)',
            marginBottom: 8,
            lineHeight: 1,
          }}
        >
          404
        </p>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.11px',
            color: 'var(--tx-primary)',
            marginBottom: 8,
          }}
        >
          Page not found
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--tx-secondary)',
            lineHeight: 1.5,
            marginBottom: 24,
          }}
        >
          The page you are looking for does not exist.
        </p>
        <Link
          href="/dashboard"
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            backgroundColor: 'var(--bg-btn)',
            color: 'var(--tx-primary)',
            border: '1px solid var(--border-warm)',
            textDecoration: 'none',
            fontFamily: 'inherit',
          }}
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}
