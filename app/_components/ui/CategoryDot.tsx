import React from 'react'

/** Small colour swatch shown next to a category name — the same colour the
 *  Category table already stores (`colorForCategory`/DB row), rendered as a
 *  dot rather than a full pill so it drops into existing text without
 *  changing row height (Phase U5 "category color dots"). */
export function CategoryDot({ color, className = '', style }: { color: string; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-full shrink-0 ${className}`.trim()}
      style={{ width: 8, height: 8, backgroundColor: color, ...style }}
    />
  )
}
