import { describe, expect, it } from 'vitest'
import { isoDayOf, ledgerFiltersForRow, ledgerLinkForRow } from '@/lib/chatLedgerLink'
import { buildResultFrame } from '@/lib/chatResultFrame'
import { moneyUnitsPlan } from '@/lib/chatMoneyUnits'
import { parseLedgerQuery } from '@/lib/transactions-query'

// ─────────────────────────────────────────────────────────────────────────────
// [chat-model] output 10, the cross-reference to the ledger.
//
// The rule under test is the one docs/architecture.md states: a link is built
// from the `result` frame's rows and from NOTHING else — never by re-parsing
// the `sql` frame's filters, which would be a second implementation of the
// filter semantics the guards enforce. A row with no ledger-filterable
// dimension gets no link, not a widened guess.
//
// Kept a pure function precisely so this is testable without a browser.
// ─────────────────────────────────────────────────────────────────────────────

const columnsOf = (rows: Record<string, unknown>[]) =>
  buildResultFrame({
    rows,
    plan: moneyUnitsPlan('SELECT 1'),
    currency: 'AED',
    truncated: null,
  }).columns

describe('isoDayOf', () => {
  it('reads a stored datetime string', () => {
    expect(isoDayOf('2026-06-14 00:00:00.000')).toBe('2026-06-14')
  })

  it('reads a bare ISO day and a Date', () => {
    expect(isoDayOf('2026-06-14')).toBe('2026-06-14')
    expect(isoDayOf(new Date('2026-06-14T00:00:00.000Z'))).toBe('2026-06-14')
  })

  it('a month bucket is not a day — the ledger has no month filter', () => {
    expect(isoDayOf('2026-06')).toBeNull()
  })

  it('rejects non-dates', () => {
    expect(isoDayOf(null)).toBeNull()
    expect(isoDayOf(1234)).toBeNull()
    expect(isoDayOf('Groceries')).toBeNull()
    expect(isoDayOf(new Date('nonsense'))).toBeNull()
  })
})

describe('ledgerFiltersForRow — one dimension at a time', () => {
  it('a date column pins a single day on both bounds', () => {
    const rows = [{ date: '2026-06-14 00:00:00.000', amount: -12.5 }]
    expect(ledgerFiltersForRow(rows[0], columnsOf(rows))).toEqual({
      startDate: '2026-06-14',
      endDate: '2026-06-14',
    })
  })

  it('a category column pins the category', () => {
    const rows = [{ category: '🛒 Groceries', total: 412.3 }]
    expect(ledgerFiltersForRow(rows[0], columnsOf(rows))).toEqual({ category: '🛒 Groceries' })
  })

  it('an empty category is the absence of one, not a filter value', () => {
    const rows = [{ category: '   ', total: 1 }]
    expect(ledgerFiltersForRow(rows[0], columnsOf(rows))).toEqual({})
  })

  it('an accountId column pins the account', () => {
    const rows = [{ accountId: 3, total: 99 }]
    expect(ledgerFiltersForRow(rows[0], columnsOf(rows))).toEqual({ accountId: 3 })
  })

  it('a non-integer accountId is not an account', () => {
    const rows = [{ accountId: 'ADCB', total: 99 }]
    expect(ledgerFiltersForRow(rows[0], columnsOf(rows))).toEqual({})
  })

  it('dimensions combine when the row carries several', () => {
    const rows = [{ date: '2026-06-14', category: '✈️ Travel', accountId: 2, amount: -80 }]
    expect(ledgerFiltersForRow(rows[0], columnsOf(rows))).toEqual({
      startDate: '2026-06-14',
      endDate: '2026-06-14',
      category: '✈️ Travel',
      accountId: 2,
    })
  })

  it('result keys are matched case-insensitively, as elsewhere in the frame', () => {
    const rows = [{ DATE: '2026-06-14', Category: '✈️ Travel' }]
    expect(ledgerFiltersForRow(rows[0], columnsOf(rows))).toMatchObject({
      startDate: '2026-06-14',
      category: '✈️ Travel',
    })
  })
})

describe('ledgerLinkForRow', () => {
  it('builds a ledger URL from the row dimensions', () => {
    const rows = [{ date: '2026-06-14 00:00:00.000', category: '✈️ Travel', amount: -80 }]
    expect(ledgerLinkForRow(rows[0], columnsOf(rows))).toBe(
      '/ledger?category=%E2%9C%88%EF%B8%8F+Travel&startDate=2026-06-14&endDate=2026-06-14',
    )
  })

  it('no qualifying dimension means no link, never a guessed one', () => {
    const rows = [{ total_spent: 1234.56 }]
    expect(ledgerLinkForRow(rows[0], columnsOf(rows))).toBeNull()
  })

  it('a month-grouped aggregate links by nothing — a month bucket is not a day bound', () => {
    const rows = [{ month: '2026-06', total: 900 }, { month: '2026-07', total: 850 }]
    expect(ledgerLinkForRow(rows[0], columnsOf(rows))).toBeNull()
  })

  it('the emitted params are the ledger\'s own, and round-trip through its parser', () => {
    // The guarantee that matters: a param this file emits that the ledger did
    // not parse would silently widen the view rather than fail loudly.
    const rows = [{ date: '2026-06-14', category: '🛒 Groceries', accountId: 3 }]
    const href = ledgerLinkForRow(rows[0], columnsOf(rows))!
    const parsed = parseLedgerQuery(new URLSearchParams(href.split('?')[1]))
    expect(parsed).toMatchObject({
      accountId: 3,
      category: '🛒 Groceries',
      startDate: '2026-06-14',
      endDate: '2026-06-14',
    })
  })

  it('is stable across calls — the URL is not render-order dependent', () => {
    const rows = [{ accountId: 1, category: 'Rent', date: '2026-06-01' }]
    const columns = columnsOf(rows)
    expect(ledgerLinkForRow(rows[0], columns)).toBe(ledgerLinkForRow(rows[0], columns))
  })
})
