'use client'

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react'

export type ToastVariant = 'success' | 'error' | 'info'

export type ToastOptions = {
  message: string
  variant?: ToastVariant
  /** ms before auto-dismiss; 0 keeps it until dismissed. Default 4000. */
  duration?: number
  /** Optional action button (e.g. "Undo"). */
  action?: { label: string; onClick: () => void }
}

type Toast = ToastOptions & { id: number; variant: ToastVariant }

type ToastApi = {
  notify: (opts: ToastOptions) => number
  success: (message: string, opts?: Omit<ToastOptions, 'message' | 'variant'>) => number
  error: (message: string, opts?: Omit<ToastOptions, 'message' | 'variant'>) => number
  info: (message: string, opts?: Omit<ToastOptions, 'message' | 'variant'>) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Access the toast API. Must be used under <ToastProvider> (mounted in the
 *  root layout), so it is available app-wide. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

const VARIANT_STYLE: Record<ToastVariant, { bg: string; fg: string; border: string; Icon: typeof CheckCircle }> = {
  success: { bg: 'var(--bg-notify-success)', fg: 'var(--tx-notify-success)', border: 'var(--border-warm)', Icon: CheckCircle },
  error:   { bg: 'var(--bg-notify-error)',   fg: 'var(--tx-notify-error)',   border: 'var(--border-warm)', Icon: AlertCircle },
  info:    { bg: 'var(--bg-card)',            fg: 'var(--tx-primary)',        border: 'var(--border-warm)', Icon: Info },
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) { clearTimeout(timer); timers.current.delete(id) }
  }, [])

  const notify = useCallback((opts: ToastOptions) => {
    const id = nextId.current++
    const toast: Toast = { id, variant: opts.variant ?? 'info', ...opts }
    setToasts((prev) => [...prev, toast])
    const duration = opts.duration ?? 4000
    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration))
    }
    return id
  }, [dismiss])

  const api = useMemo<ToastApi>(() => ({
    notify,
    success: (message, opts) => notify({ message, variant: 'success', ...opts }),
    error: (message, opts) => notify({ message, variant: 'error', ...opts }),
    info: (message, opts) => notify({ message, variant: 'info', ...opts }),
    dismiss,
  }), [notify, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 100,
          display: 'flex', flexDirection: 'column', gap: 8,
          maxWidth: 'min(380px, calc(100vw - 40px))',
        }}
      >
        {toasts.map((t) => {
          const s = VARIANT_STYLE[t.variant]
          const { Icon } = s
          return (
            <div
              key={t.id}
              role="status"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '11px 13px', borderRadius: 10,
                backgroundColor: s.bg, color: s.fg,
                border: `1px solid ${s.border}`, boxShadow: 'var(--shadow-card, 0 6px 24px rgba(0,0,0,0.16))',
                fontSize: 13, lineHeight: 1.5,
                animation: 'ydb-toast-in 0.18s cubic-bezier(0.22,1,0.36,1) both',
              }}
            >
              <Icon size={15} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{t.message}</span>
              {t.action && (
                <button
                  onClick={() => { t.action!.onClick(); dismiss(t.id) }}
                  style={{
                    flexShrink: 0, fontWeight: 600, color: s.fg, textDecoration: 'underline',
                    background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                style={{ flexShrink: 0, color: s.fg, opacity: 0.6, background: 'none', border: 'none', cursor: 'pointer', marginTop: 1 }}
              >
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
