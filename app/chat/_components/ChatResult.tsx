'use client'

import { fmtMoney } from '@/lib/money'
import { formatDate } from '@/lib/format'
import type { ResultColumn, ResultFrame } from '@/lib/chatResultFrame'

/**
 * ADR-0023's `result` frame, rendered. Three presentations of one contract:
 * `card` (a single figure), `transactions` (the line items behind a total, so
 * the number can be audited rather than trusted) and `table` (everything
 * else). All three read the same `columns`/`rows`.
 *
 * Values arrive formatted-ready: money is already in currency units (ADR-0020
 * converted it server-side), so this file formats and never converts. The
 * money helper is `lib/money.ts`'s `fmtMoney`, the same one the ledger uses —
 * it takes cents, hence the round-trip back to cents below rather than a
 * second formatting scheme invented here.
 *
 * Column labels are the model's aliases verbatim (ADR-0010): a label is a
 * claim, not a description, and prettifying one here would launder it.
 */

function formatValue(value: unknown, column: ResultColumn, currency: string): string {
  if (value === null || value === undefined) return '—'
  if (column.kind === 'money' && typeof value === 'number') {
    return fmtMoney(Math.round(value * 100), currency)
  }
  if (column.kind === 'date') return formatDate(value as string | Date)
  if (column.kind === 'number' && typeof value === 'number') {
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  return String(value)
}

const panelStyle: React.CSSProperties = {
  marginTop: '8px',
  borderRadius: '12px',
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  overflow: 'hidden',
}

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--tx-secondary)',
}

function TruncationNote({ truncated }: { truncated: NonNullable<ResultFrame['truncated']> }) {
  return (
    <div style={{
      padding: '6px 12px',
      fontSize: '11px',
      color: 'var(--tx-secondary)',
      borderTop: '1px solid var(--border-warm)',
    }}>
      Showing {truncated.shown} of {truncated.dbCapped ? 'more than ' : ''}
      {truncated.total} rows{truncated.dbCapped ? ' (capped by the server)' : ''}.
    </div>
  )
}

export function ChatResult({ result }: { result: ResultFrame }) {
  const { present, columns, rows, currency, truncated } = result
  if (columns.length === 0 || rows.length === 0) return null

  if (present === 'card') {
    const column = columns[0]
    return (
      <div style={{ ...panelStyle, padding: '14px 16px' }}>
        <div style={{ ...labelStyle, marginBottom: '4px', fontFamily: 'ui-monospace, monospace', textTransform: 'none' }}>
          {column.label}
        </div>
        <div style={{ fontSize: '26px', fontWeight: 600, color: 'var(--tx-primary)', lineHeight: 1.2 }}>
          {formatValue(rows[0][column.key], column, currency)}
        </div>
      </div>
    )
  }

  if (present === 'transactions') {
    // Annotated line items: date and description carry the row, the amount is
    // the figure being audited, and every remaining column trails as a small
    // annotation rather than being dropped.
    const dateCol = columns.find((c) => c.key.toLowerCase() === 'date')!
    const amountCol = columns.find((c) => c.key.toLowerCase() === 'amount')!
    const descCol = columns.find((c) => c.key.toLowerCase() === 'description')
    const restCols = columns.filter((c) => c !== dateCol && c !== amountCol && c !== descCol)

    return (
      <div style={panelStyle}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((row, i) => {
            const primary = descCol ? formatValue(row[descCol.key], descCol, currency) : formatValue(row[dateCol.key], dateCol, currency)
            const annotations = [
              ...(descCol ? [formatValue(row[dateCol.key], dateCol, currency)] : []),
              ...restCols.map((c) => `${c.label}: ${formatValue(row[c.key], c, currency)}`),
            ]
            return (
            <li key={i} style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '8px 12px',
              borderTop: i === 0 ? 'none' : '1px solid var(--border-warm)',
              fontSize: '13px',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: 'var(--tx-primary)', wordBreak: 'break-word' }}>{primary}</div>
                {annotations.length > 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--tx-secondary)', wordBreak: 'break-word' }}>
                    {annotations.join(' · ')}
                  </div>
                )}
              </div>
              <div style={{
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--tx-primary)',
                fontWeight: 500,
              }}>
                {formatValue(row[amountCol.key], amountCol, currency)}
              </div>
            </li>
            )
          })}
        </ul>
        {truncated && <TruncationNote truncated={truncated} />}
      </div>
    )
  }

  return (
    <div style={panelStyle}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px' }}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={{
                  ...labelStyle,
                  textAlign: c.kind === 'money' || c.kind === 'number' ? 'right' : 'left',
                  padding: '8px 12px',
                  whiteSpace: 'nowrap',
                  textTransform: 'none',
                  fontFamily: 'ui-monospace, monospace',
                  borderBottom: '1px solid var(--border-warm)',
                }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} style={{
                    padding: '7px 12px',
                    textAlign: c.kind === 'money' || c.kind === 'number' ? 'right' : 'left',
                    color: 'var(--tx-primary)',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-warm)',
                    fontVariantNumeric: c.kind === 'money' || c.kind === 'number' ? 'tabular-nums' : 'normal',
                    whiteSpace: c.kind === 'money' || c.kind === 'number' || c.kind === 'date' ? 'nowrap' : 'normal',
                  }}>
                    {formatValue(row[c.key], c, currency)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && <TruncationNote truncated={truncated} />}
    </div>
  )
}
