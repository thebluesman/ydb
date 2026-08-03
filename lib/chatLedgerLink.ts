/**
 * Cross-reference from a chat result row to the ledger (`[chat-model]` Tier 1
 * output 10).
 *
 * `docs/architecture.md` records this as frontend-only and needing no wire
 * change, with one rule that is the whole design: **the link is built from the
 * `result` frame's rows, and from nothing else.** In particular it is never
 * built by re-parsing the `sql` frame's filter text. That would be a second,
 * divergent implementation of the filter semantics the guards enforce, and a
 * link whose ledger view covers a different set than the number printed above
 * it is ADR-0010's "a label is a claim" failure wearing a URL.
 *
 * The consequence is accepted rather than worked around: if the rows do not
 * carry the dimension, there is no link. A `SELECT SUM(amount)` with no
 * grouping projects no date, category or account, so its card gets no link at
 * all — which is correct, because the set behind that figure is not expressible
 * in the ledger's filter vocabulary without re-deriving the WHERE clause.
 *
 * Query parameters are the ledger's own, read straight off `parseLedgerQuery`
 * in `lib/transactions-query.ts` (`accountId`, `category`, `startDate`,
 * `endDate`). Nothing new is invented here: a param this file emitted that the
 * ledger did not parse would silently widen the view rather than fail.
 *
 * Pure and side-effect free so it can be unit-tested without a browser.
 */

import type { ResultColumn } from './chatResultFrame'

export const LEDGER_PATH = '/ledger'

/** `YYYY-MM-DD`, optionally followed by a time part — the stored date shape. */
const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})([T ]|$)/

/**
 * The ISO calendar day a result value denotes, or `null`.
 *
 * SQLite hands dates back as strings; a driver that produced a `Date` is
 * handled too. Anything else is not a day and must not become a date filter —
 * a `strftime('%Y-%m', …)` month bucket lands here as `'2026-06'` and is
 * correctly rejected, because the ledger's `startDate`/`endDate` are day
 * bounds and a month is not one of them.
 */
export function isoDayOf(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return value.toISOString().slice(0, 10)
  }
  if (typeof value !== 'string') return null
  const match = ISO_DATE_RE.exec(value)
  return match ? match[1] : null
}

export type LedgerFilters = {
  accountId?: number
  category?: string
  startDate?: string
  endDate?: string
}

/**
 * The ledger filters a single result row supports, taken column by column.
 *
 * Recognised dimensions, all matched on the result key case-insensitively
 * (SQLite echoes a projection's casing back, and `SELECT DATE` is the same
 * query as `SELECT date`):
 *
 *   - a `date` column, when its value is a real calendar day, pins the ledger
 *     to that single day (`startDate` = `endDate`);
 *   - a `category` column pins the category filter;
 *   - an `accountId` column pins the account filter.
 *
 * A column the ledger has no filter for contributes nothing. That includes
 * `id`: the ledger has no per-transaction deep link today, and inventing an
 * `?id=` param would mean changing the ledger's shared filter predicate, which
 * is outside a frontend-only change. See the PR notes.
 */
export function ledgerFiltersForRow(
  row: Record<string, unknown>,
  columns: readonly ResultColumn[],
): LedgerFilters {
  const filters: LedgerFilters = {}

  for (const column of columns) {
    const key = column.key.toLowerCase()
    const value = row[column.key]
    if (value === null || value === undefined) continue

    if (key === 'date' && filters.startDate === undefined) {
      const day = isoDayOf(value)
      if (day) {
        filters.startDate = day
        filters.endDate = day
      }
      continue
    }

    if (key === 'category' && filters.category === undefined) {
      // An empty category is the ABSENCE of a category, not a category named
      // "" — and `parseLedgerQuery` would drop it anyway. Linking to it would
      // silently produce an unfiltered ledger.
      if (typeof value === 'string' && value.trim().length > 0) filters.category = value
      continue
    }

    if (key === 'accountid' && filters.accountId === undefined) {
      const id = typeof value === 'number' ? value : Number(value)
      if (Number.isInteger(id) && id > 0) filters.accountId = id
      continue
    }
  }

  return filters
}

/**
 * The ledger URL for a row, or `null` when the row carries no dimension the
 * ledger can filter on.
 *
 * `null` is the honest answer and the common one. A guessed link — the whole
 * ledger, or the row's month because its day was not projected — would claim
 * to show the rows behind a figure while showing a different set.
 *
 * Params are emitted in a fixed order so the URL is stable across renders and
 * assertable in a test.
 */
export function ledgerLinkForRow(
  row: Record<string, unknown>,
  columns: readonly ResultColumn[],
): string | null {
  const filters = ledgerFiltersForRow(row, columns)

  const params = new URLSearchParams()
  if (filters.accountId !== undefined) params.set('accountId', String(filters.accountId))
  if (filters.category !== undefined) params.set('category', filters.category)
  if (filters.startDate !== undefined) params.set('startDate', filters.startDate)
  if (filters.endDate !== undefined) params.set('endDate', filters.endDate)

  const query = params.toString()
  return query ? `${LEDGER_PATH}?${query}` : null
}
