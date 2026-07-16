import React from 'react'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/** Input primitive — border-warm + bg-input + radius 6, orange focus ring from globals. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className = '', ...props }, ref) {
    return <input ref={ref} className={`ui-input ${className}`.trim()} {...props} />
  }
)
