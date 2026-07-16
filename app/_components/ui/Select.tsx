'use client'

import React from 'react'
import * as RSelect from '@radix-ui/react-select'
import { ChevronDown } from 'lucide-react'

export type SelectOption = {
  value: string
  label: string
  /** Optional leading dot colour (type selects). */
  dot?: string
  /** Optional per-option trigger text colour when selected. */
  color?: string
  /** Optional per-item text colour override. */
  itemColor?: string
}

type Size = 'xs' | 'sm' | 'md'

const TRIGGER_BY_SIZE: Record<Size, string> = {
  xs: 'gap-1.5 px-2 py-1 text-xs rounded-[4px]',
  sm: 'gap-1.5 px-2 py-1.5 text-sm rounded-[6px]',
  md: 'gap-2 px-3 py-2 text-sm rounded-[8px]',
}
const CHEVRON_BY_SIZE: Record<Size, number> = { xs: 10, sm: 12, md: 14 }

export type SelectProps = {
  value: string
  onValueChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  ariaLabel?: string
  size?: Size
  fullWidth?: boolean
  /** Show the selected option's dot in the trigger. */
  showDot?: boolean
  /** Colour the trigger text from the selected option's `color`. */
  colorFromOption?: boolean
  className?: string
  triggerStyle?: React.CSSProperties
  contentMinWidth?: string
}

const CONTENT_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  boxShadow: 'var(--shadow-ambient)',
  borderRadius: '8px',
  zIndex: 9999,
}

/**
 * The single Radix Select wrapper. Replaces the hand-rolled FilterSelect /
 * TypeSelect / SimpleSelect copies. Item hover comes from the
 * `.ui-select-item[data-highlighted]` CSS rule — no onMouseEnter/Leave.
 * Dropdown uses the ambient (raised) shadow so modals still read as "above".
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  ariaLabel,
  size = 'sm',
  fullWidth = true,
  showDot = false,
  colorFromOption = false,
  className = '',
  triggerStyle,
  contentMinWidth = 'var(--radix-select-trigger-width)',
}: SelectProps) {
  const current = options.find((o) => o.value === value)
  const triggerColor = colorFromOption && current?.color ? current.color : 'var(--tx-primary)'
  return (
    <RSelect.Root value={value} onValueChange={onValueChange}>
      <RSelect.Trigger
        aria-label={ariaLabel}
        className={`flex items-center outline-none ${fullWidth ? 'w-full' : ''} ${TRIGGER_BY_SIZE[size]} ${className}`.trim()}
        style={{
          border: '1px solid var(--border-warm)',
          backgroundColor: 'var(--bg-input)',
          color: triggerColor,
          ...triggerStyle,
        }}
      >
        {showDot && current?.dot && (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: current.dot }} />
        )}
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={CHEVRON_BY_SIZE[size]} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="overflow-hidden"
          style={{ ...CONTENT_STYLE, minWidth: contentMinWidth }}
        >
          <RSelect.Viewport className="p-1">
            {options.map((opt) => (
              <RSelect.Item
                key={opt.value}
                value={opt.value}
                className="ui-select-item flex items-center gap-2 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
                style={{ color: opt.itemColor ?? 'var(--tx-primary)' }}
              >
                {opt.dot && (
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: opt.dot }} />
                )}
                <RSelect.ItemText>{opt.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}
