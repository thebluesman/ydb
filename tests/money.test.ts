import { describe, expect, it } from 'vitest'
import { fromCents, parseCents, toCents, formatCents } from '@/lib/money'

describe('toCents / fromCents', () => {
  it('round-trips common values', () => {
    for (const v of [0, 1, 42.5, 1234.56, 999.99]) {
      expect(fromCents(toCents(v))).toBeCloseTo(v, 2)
    }
  })

  it('handles negatives', () => {
    expect(toCents(-42.5)).toBe(-4250)
    expect(fromCents(-4250)).toBe(-42.5)
  })

  it('avoids floating-point drift on 0.1 + 0.2', () => {
    // Whole point of the migration: the unit-test that wouldn't pass before.
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(toCents(0.3)).toBe(30)
  })

  it('returns 0 for non-finite input', () => {
    expect(toCents(NaN)).toBe(0)
    expect(toCents(Infinity)).toBe(0)
  })
})

describe('parseCents', () => {
  it('parses plain numbers', () => {
    expect(parseCents('42.50')).toBe(4250)
    expect(parseCents('1000')).toBe(100_000)
  })
  it('strips currency symbols and thousands separators', () => {
    expect(parseCents('$1,234.56')).toBe(123_456)
    expect(parseCents('AED 50.00')).toBe(5000)
  })
  it('reads European decimals', () => {
    expect(parseCents('1,99')).toBe(199)
  })
  it('reads accounting parens as negative', () => {
    expect(parseCents('(50.00)')).toBe(-5000)
  })
  it('returns null for blank or garbage', () => {
    expect(parseCents('')).toBeNull()
    expect(parseCents('   ')).toBeNull()
  })
})

describe('formatCents', () => {
  it('formats USD with two decimals', () => {
    // Intl varies across locales — just assert the key pieces.
    const out = formatCents(123_456, 'USD')
    expect(out).toContain('1,234.56')
    expect(out).toMatch(/\$|USD/)
  })
})
