'use client'

import { useState } from 'react'
import { Download, DatabaseBackup } from 'lucide-react'

type BackupEntry = {
  filename: string
  createdAt: string
  sizeBytes: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function BackupManager({ initialBackups }: { initialBackups: BackupEntry[] }) {
  const [backups, setBackups] = useState<BackupEntry[]>(initialBackups)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputStyle = {
    backgroundColor: 'var(--bg-input)',
    border: '1px solid var(--border-warm)',
    color: 'var(--tx-primary)',
    borderRadius: '6px',
    fontSize: '13px',
    padding: '6px 10px',
  }

  async function handleBackupNow() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/backup', { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setBackups((prev) => [data.backup, ...prev].slice(0, 14))
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--tx-secondary)' }}>
          {backups.length === 0
            ? 'No backups yet.'
            : `${backups.length} backup${backups.length === 1 ? '' : 's'} stored · last 14 kept`}
        </p>
        <button
          onClick={handleBackupNow}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-[6px] transition-opacity disabled:opacity-50"
          style={{ ...inputStyle, padding: '6px 12px', cursor: loading ? 'default' : 'pointer' }}
        >
          <DatabaseBackup size={13} />
          {loading ? 'Backing up…' : 'Back up now'}
        </button>
      </div>

      {error && (
        <p className="text-xs" style={{ color: 'var(--color-error, #e53e3e)' }}>
          {error}
        </p>
      )}

      {backups.length > 0 && (
        <div
          className="rounded-[6px] overflow-hidden"
          style={{ border: '1px solid var(--border-warm)' }}
        >
          {backups.map((b, i) => (
            <div
              key={b.filename}
              className="flex items-center justify-between px-3 py-2.5 gap-3"
              style={{
                backgroundColor: i % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-card-alt, var(--bg-card))',
                borderTop: i > 0 ? '1px solid var(--border-warm)' : undefined,
              }}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span
                  className="font-mono text-xs truncate"
                  style={{ color: 'var(--tx-primary)' }}
                >
                  {b.filename}
                </span>
                <span className="text-xs" style={{ color: 'var(--tx-secondary)' }}>
                  {formatDate(b.createdAt)} · {formatSize(b.sizeBytes)}
                </span>
              </div>
              <a
                href={`/api/backup/${encodeURIComponent(b.filename)}`}
                download={b.filename}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-[5px] flex-shrink-0"
                style={{
                  color: 'var(--tx-secondary)',
                  border: '1px solid var(--border-warm)',
                  backgroundColor: 'var(--bg-input)',
                }}
              >
                <Download size={11} />
                Download
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
