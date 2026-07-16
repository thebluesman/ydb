'use client'

import React from 'react'

type Variant = 'primary' | 'default' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
}

/**
 * Button primitive. Hover/focus states come from CSS classes (.btn-*), never
 * JS mouse handlers. `primary` is the accent-orange action — convention is one
 * per screen (see Phase U1.5 action hierarchy).
 */
export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      {...props}
    />
  )
}
