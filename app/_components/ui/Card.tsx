import React from 'react'

export type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  as?: React.ElementType
}

/** Card primitive — bg-card + border-warm + radius 8 (the repeated inline cardStyle). */
export function Card({ as: Tag = 'div', className = '', ...props }: CardProps) {
  return <Tag className={`card ${className}`.trim()} {...props} />
}
