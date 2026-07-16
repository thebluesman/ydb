import React from 'react'

/** A pulsing placeholder block. Width/height via style or className. Used by
 *  the per-route loading.tsx screens so first navigation shows structure
 *  instead of a frozen blank page. */
export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`.trim()} style={style} aria-hidden="true" />
}
