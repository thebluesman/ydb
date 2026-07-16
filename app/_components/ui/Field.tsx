import React from 'react'

export type FieldProps = {
  label: React.ReactNode
  htmlFor?: string
  className?: string
  labelClassName?: string
  children: React.ReactNode
}

/** Field — the repeated uppercase-tracked label + control wrapper. */
export function Field({ label, htmlFor, className = '', labelClassName = '', children }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={`ui-field-label ${labelClassName}`.trim()}>
        {label}
      </label>
      {children}
    </div>
  )
}
