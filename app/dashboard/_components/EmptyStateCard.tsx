'use client'

import Link from 'next/link'
import { Inbox } from 'lucide-react'

/** Replaces a chart/table body when the selected filters (currency/date
 *  range) match zero transactions — shown instead of an empty/blank chart
 *  (Phase U5). */
export function EmptyStateCard({
  title = 'No activity in this period',
  message = 'Try a wider date range, or import a statement to get some data in here.',
  ctaHref = '/upload',
  ctaLabel = 'Upload a statement',
}: {
  title?: string
  message?: string
  ctaHref?: string
  ctaLabel?: string
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <span
        className="flex items-center justify-center rounded-full"
        style={{ width: 40, height: 40, backgroundColor: 'var(--bg-card-alt)', color: 'var(--tx-tertiary)' }}
      >
        <Inbox size={18} />
      </span>
      <p className="text-sm font-medium" style={{ color: 'var(--tx-primary)' }}>{title}</p>
      <p className="text-xs max-w-xs" style={{ color: 'var(--tx-faint)' }}>{message}</p>
      <Link
        href={ctaHref}
        className="btn px-3 py-1.5 text-xs rounded-[6px] transition-colors duration-150"
        style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
      >
        {ctaLabel}
      </Link>
    </div>
  )
}
