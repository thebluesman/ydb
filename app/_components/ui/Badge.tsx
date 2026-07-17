import React from 'react'

export type BadgeVariant =
  | 'positive'
  | 'negative'
  | 'caution'
  | 'info'
  | 'transfer'
  | 'neutral'

const VARIANT_TOKENS: Record<BadgeVariant, { bg: string; tx: string }> = {
  positive: { bg: 'var(--bg-positive)', tx: 'var(--tx-positive)' },
  negative: { bg: 'var(--bg-negative)', tx: 'var(--tx-negative)' },
  caution:  { bg: 'var(--bg-caution)',  tx: 'var(--tx-caution)' },
  info:     { bg: 'var(--bg-info)',     tx: 'var(--tx-info)' },
  transfer: { bg: 'var(--bg-transfer)', tx: 'var(--tx-transfer-deep)' },
  neutral:  { bg: 'var(--bg-card-alt)', tx: 'var(--tx-tertiary)' },
}

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant
  /** 'pill' = rounded-full status badge; 'tag' = small rounded-[4px] inline tag. */
  shape?: 'pill' | 'tag'
  pop?: boolean
}

/** Status / type pill. Consumes the collapsed semantic token pairs. */
export function Badge({
  variant = 'neutral',
  shape = 'pill',
  pop = false,
  className = '',
  style,
  ...props
}: BadgeProps) {
  const { bg, tx } = VARIANT_TOKENS[variant]
  const base =
    shape === 'pill'
      ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs'
      : 'inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-[var(--radius-xs)]'
  return (
    <span
      className={`${pop ? 'badge-pop ' : ''}${base} ${className}`.trim()}
      style={{ backgroundColor: bg, color: tx, ...style }}
      {...props}
    />
  )
}
