/**
 * The `result` NDJSON frame (ADR-0023).
 *
 * One frame type carries the executed result set to the client, plus a
 * presentation hint the ROUTE chooses from the rows. Table, stat card and
 * annotated transaction list are three renderings of this one contract, not
 * three frame types — every value of `present` carries the same
 * `columns`/`rows`, so a client that renders all three as a table is correct,
 * just plainer.
 *
 * Why the route decides `present` rather than the narration model: a typed
 * marker in the token stream would put a control channel inside prose that is,
 * post-YNAB-import, third-party-controlled text (see the `[chat-security]`
 * comment in `app/api/chat/route.ts`). The containment argument there rests on
 * the reader consuming only `chunk.response` as escaped text, so injection
 * costs a wrong sentence rather than a forged frame. A deterministic rule over
 * already-cleared rows keeps that property.
 *
 * Everything here is pure and runs strictly AFTER the guard chain, after
 * `applyMoneyUnits` (ADR-0020), after the no-data check and after
 * `applyMoneySign` (ADR-0027) — it gates nothing and skips nothing. The rows
 * it carries are the same values narration is handed, sign included, which is
 * what stops the sentence and the table disagreeing about a minus sign.
 */

import type { MoneyUnitsPlan } from './chatMoneyUnits'

export type ResultColumnKind = 'money' | 'date' | 'number' | 'text'

export type ResultPresent = 'card' | 'table' | 'transactions'

export type ResultColumn = {
  key: string
  /**
   * The result key verbatim. ADR-0010's rule holds: a label is a claim, not a
   * description, and the alias is the model's. The frame does not launder it
   * into something friendlier, exactly as narration does not.
   */
  label: string
  kind: ResultColumnKind
}

/**
 * `shown` / `total` are row counts of the SAME row set narration saw.
 * `dbCapped` means `executeReadonlyQuery` already cut the result at its own
 * hard cap upstream, so `total` is a floor, not the real count.
 */
export type ResultTruncation = { shown: number; total: number; dbCapped: boolean }

export type ResultFrame = {
  type: 'result'
  present: ResultPresent
  currency: string
  columns: ResultColumn[]
  rows: Record<string, unknown>[]
  truncated: ResultTruncation | null
}

/**
 * Scalar columns of `Transaction` in prisma/schema.prisma (relation fields
 * excluded — they never appear as result keys). Used only by the
 * `transactions` classification below; it is a styling decision, so an
 * out-of-date entry costs a plainer table, never a wrong number.
 */
const TRANSACTION_COLUMNS = [
  'id', 'date', 'amount', 'description', 'originalDescription', 'transactionType',
  'category', 'accountId', 'status', 'notes', 'rawSource', 'createdVia',
  'linkedTransferId', 'parentTransactionId', 'reimbursableFor', 'reimbursementTxId',
  'transferCounterpartAccountId', 'ynabId', 'ynabFingerprint', 'createdAt', 'updatedAt',
]

const TRANSACTION_COLUMN_SET = new Set(TRANSACTION_COLUMNS.map((c) => c.toLowerCase()))

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]|$)/

function isRowObject(row: unknown): row is Record<string, unknown> {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
}

/** Union of row keys in first-seen order. SQLite hands back uniform rows; the
 *  union is defensive, not expected to differ. */
export function resultColumnKeys(rows: unknown[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isRowObject(row)) continue
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

/** `date` / `number` / `text` from the first non-null value of the column. */
function inferKind(rows: unknown[], key: string): ResultColumnKind {
  for (const row of rows) {
    if (!isRowObject(row)) continue
    const value = row[key]
    if (value === null || value === undefined) continue
    if (value instanceof Date) return 'date'
    if (typeof value === 'number') return 'number'
    if (typeof value === 'string') return ISO_DATE_RE.test(value) ? 'date' : 'text'
    return 'text'
  }
  return 'text'
}

/**
 * ADR-0023's deterministic rule, over the final rows:
 *
 *   card         — exactly one row and one column.
 *   transactions — more than one row, every key is a `Transaction` column
 *                  name, and `date` and `amount` are both among them.
 *   table        — everything else.
 *
 * Key matching is case-insensitive: SQLite echoes a projection's casing back
 * as the result key, and `SELECT DATE, AMOUNT` is the same query. This is a
 * styling decision only, so a loose match here cannot affect a value.
 */
export function classifyPresent(rows: unknown[], keys: string[] = resultColumnKeys(rows)): ResultPresent {
  if (rows.length === 1 && keys.length === 1) return 'card'
  if (rows.length > 1 && keys.length > 0) {
    const lower = keys.map((k) => k.toLowerCase())
    const allTransactionColumns = lower.every((k) => TRANSACTION_COLUMN_SET.has(k))
    if (allTransactionColumns && lower.includes('date') && lower.includes('amount')) {
      return 'transactions'
    }
  }
  return 'table'
}

/**
 * Build the frame from the rows narration receives.
 *
 * `kind: 'money'` membership is the plan's `moneyKeys` (ADR-0027), not its
 * `convertKeys`: a key is money when its projection resolves to a money
 * column, whether or not the server had to divide it. ADR-0023 originally
 * stated the `convertKeys` rule, reusing ADR-0020's classifier as-is; that was
 * wrong for the dominant query shape, because every projection that already
 * divides by 100 — all nine of the SQL prompt's worked examples — classifies
 * as `already-converted` and never enters `convertKeys`, so the commonest
 * money column in the app rendered as a bare number with no currency.
 *
 * The plan is passed in rather than recomputed from `sql`, so this frame and
 * the route's own `applyMoneyUnits`/`applyMoneySign` calls are guaranteed to
 * be reading one plan and cannot drift. Money values are already in currency
 * units with their display sign already applied; the client formats, never
 * converts.
 */
export function buildResultFrame({
  rows,
  plan,
  currency,
  truncated,
}: {
  rows: unknown[]
  plan: MoneyUnitsPlan
  currency: string
  truncated: ResultTruncation | null
}): ResultFrame {
  const keys = resultColumnKeys(rows)

  const moneyKeys = new Set(plan.kind === 'ok' ? plan.moneyKeys : [])

  const columns: ResultColumn[] = keys.map((key) => ({
    key,
    label: key,
    kind: moneyKeys.has(key) ? 'money' : inferKind(rows, key),
  }))

  return {
    type: 'result',
    present: classifyPresent(rows, keys),
    currency,
    columns,
    rows: rows.filter(isRowObject),
    truncated,
  }
}
