'use client'

import { useState } from 'react'
import { DayPicker, type DayButtonProps } from 'react-day-picker'
import * as Popover from '@radix-ui/react-popover'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDate(s: string): Date | undefined {
  if (!s) return undefined
  const d = new Date(`${s}T12:00:00`)
  return isNaN(d.getTime()) ? undefined : d
}

function formatDisplay(s: string): string {
  const d = parseDate(s)
  if (!d) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function toYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── Custom day button (handles hover inline) ──────────────────────────────────

function CustomDayButton({ day, modifiers, ...props }: DayButtonProps) {
  const [hovered, setHovered] = useState(false)
  const sel = modifiers.selected
  const dis = modifiers.disabled
  const tod = modifiers.today && !sel
  const out = modifiers.outside

  const bg = sel ? 'var(--bg-selected)' : hovered && !dis ? 'var(--bg-card-alt)' : 'transparent'
  const color = sel
    ? 'var(--tx-selected)'
    : tod
    ? '#f54e00'
    : out
    ? 'var(--tx-faint)'
    : 'var(--tx-primary)'

  return (
    <button
      {...props}
      onMouseEnter={() => !dis && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 32,
        height: 32,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: sel ? 700 : tod ? 700 : 400,
        cursor: dis ? 'not-allowed' : 'pointer',
        outline: 'none',
        border: 'none',
        background: bg,
        color,
        opacity: dis ? 0.25 : out && !sel ? 0.4 : 1,
        transition: 'background 80ms, color 80ms',
        fontFamily: 'inherit',
      }}
    />
  )
}

// ── Nav button ────────────────────────────────────────────────────────────────

function NavBtn({ onClick, disabled, children }: {
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
  children: React.ReactNode
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hov && !disabled ? 'var(--bg-card-alt)' : 'transparent',
        border: '1px solid var(--border-warm)',
        color: 'var(--tx-tertiary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.3 : 1,
        outline: 'none',
        transition: 'background 80ms',
        padding: 0,
      }}
    >
      {children}
    </button>
  )
}

// ── DatePicker ────────────────────────────────────────────────────────────────

type Size = 'sm' | 'md'

type Props = {
  /** YYYY-MM-DD */
  value: string
  onChange: (value: string) => void
  className?: string
  style?: React.CSSProperties
  /** 'sm' for compact filter-bar usage, 'md' for form fields */
  size?: Size
}

export function DatePicker({ value, onChange, className, style, size = 'md' }: Props) {
  const [open, setOpen] = useState(false)
  const [hovTrigger, setHovTrigger] = useState(false)
  const selected = parseDate(value)
  const isSm = size === 'sm'

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={className}
          onMouseEnter={() => setHovTrigger(true)}
          onMouseLeave={() => setHovTrigger(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: isSm ? '4px 8px' : '6px 8px',
            borderRadius: 6,
            border: `1px solid ${hovTrigger || open ? 'var(--border-warm-md)' : 'var(--border-warm)'}`,
            backgroundColor: 'var(--bg-input)',
            color: value ? 'var(--tx-primary)' : 'var(--tx-faint)',
            fontSize: isSm ? 12 : 14,
            cursor: 'pointer',
            outline: 'none',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            transition: 'border-color 100ms',
            ...style,
          }}
        >
          <CalendarDays
            size={isSm ? 11 : 13}
            style={{ color: 'var(--tx-tertiary)', flexShrink: 0 }}
          />
          <span style={{ flex: 1 }}>{value ? formatDisplay(value) : 'Pick a date'}</span>
          <ChevronDown
            size={10}
            style={{
              color: 'var(--tx-tertiary)',
              flexShrink: 0,
              transform: open ? 'rotate(180deg)' : 'none',
              transition: 'transform 150ms',
            }}
          />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={5}
          onOpenAutoFocus={(e) => e.preventDefault()}
          style={{
            zIndex: 9999,
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-warm)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-card)',
            padding: '12px',
            outline: 'none',
            // entry animation
            animation: 'calendarIn 120ms cubic-bezier(0.22,1,0.36,1)',
          }}
        >
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={(d) => {
              if (d) { onChange(toYMD(d)); setOpen(false) }
            }}
            defaultMonth={selected ?? new Date()}
            showOutsideDays
            components={{
              DayButton: CustomDayButton,
              PreviousMonthButton: ({ onClick, disabled }) => (
                <NavBtn onClick={onClick} disabled={disabled}>
                  <ChevronLeft size={13} />
                </NavBtn>
              ),
              NextMonthButton: ({ onClick, disabled }) => (
                <NavBtn onClick={onClick} disabled={disabled}>
                  <ChevronRight size={13} />
                </NavBtn>
              ),
            }}
            styles={{
              root: { fontFamily: 'inherit' },
              months: { display: 'flex', gap: 16 },
              month: { display: 'flex', flexDirection: 'column', gap: 8 },
              month_caption: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingBottom: 8,
                borderBottom: '1px solid var(--border-warm)',
              },
              caption_label: {
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--tx-primary)',
                letterSpacing: '-0.01em',
              },
              nav: { display: 'flex', alignItems: 'center', gap: 4 },
              month_grid: { borderCollapse: 'collapse', width: '100%' },
              weekdays: {},
              weekday: {
                width: 32,
                height: 28,
                textAlign: 'center',
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--tx-tertiary)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                paddingBottom: 2,
              },
              week: {},
              day: { padding: '1px' },
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
