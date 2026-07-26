// YNAB → YDB import planning (Phase 1, ADR-0001/0002/0003).
//
// `/api/ynab/preview` and `/api/ynab/import` must agree exactly on what would
// be imported — a preview that disagrees with the commit is worse than no
// preview at all, since the confirm modal is the only human checkpoint in the
// flow. So both routes call `planYnabImport()` and differ only in what they do
// with the result: preview summarises it, import writes it.
//
// Money: YNAB milliunits are converted to YDB integer cents in exactly one
// place (`milliunitsToCents`), and the resulting sign drives `transactionType`
// so the debit ≤ 0 / credit ≥ 0 invariant in lib/accounts.ts holds by
// construction. `validateTransactionWrite` then re-checks it at the boundary.
//
// Transfers (including credit card/loan payments, which YNAB models as
// transfers) are paired here into YDB's existing two-sided transfer shape
// (transactionType: 'transfer', transferCounterpartAccountId, linkedTransferId
// — the same mechanism app/api/transactions/manual/route.ts uses). An earlier
// version of this importer dropped transfer legs entirely, which silently
// broke every account balance that regularly moves money to another mapped
// account (credit card payments, loan payments, savings transfers) — see
// docs/research/ynab-vs-ydb/findings.md.

import { prisma } from '@/lib/prisma'
import { fetchYnabTransactions, milliunitsToCents, type YnabTransaction } from '@/lib/ynab'

/** Setting keys this integration owns. Deleting these two rows plus the
 *  `Transaction.ynabId` column removes all trace of it from the database. */
export const YNAB_ACCOUNT_MAP_KEY = 'ynabAccountMap'
export const YNAB_SERVER_KNOWLEDGE_KEY = 'ynabServerKnowledge'

/** YNAB leaves `category_name` null on some rows; YDB's `category` column is
 *  non-nullable and the dashboard groups by it, so nulls land here. Matches
 *  the name the rest of the app already uses for uncategorised spend. */
export const UNCATEGORIZED = 'Uncategorized'

/** `{ [ynabAccountId]: ydbAccountId }` — persisted as JSON in a Setting row. */
export type YnabAccountMap = Record<string, number>

/** One YNAB transaction resolved into YDB's shape, ready to insert. For a
 *  transfer leg, `transferCounterpartAccountId` names the YDB account on the
 *  other side and `transactionType` is always `'transfer'`. */
export type PlannedRow = {
  ynabId: string
  date: Date
  amount: number
  description: string
  originalDescription: string
  transactionType: 'credit' | 'debit' | 'transfer'
  category: string
  accountId: number
  ynabAccountName: string
  transferCounterpartAccountId?: number
}

/** Two linked rows for one YNAB transfer (which includes credit card and loan
 *  payments). Each side carries its own `ynabId` so idempotency works the
 *  same way as for a regular row — either side alone is enough to detect
 *  "already imported". */
export type PlannedTransfer = {
  side1: PlannedRow
  side2: PlannedRow
}

export type ImportPlan = {
  rows: PlannedRow[]
  transfers: PlannedTransfer[]
  serverKnowledge: string
  /** Rows/transfer-pairs YNAB returned that were already in the ledger by
   *  `ynabId`. */
  skippedAlreadyImported: number
  /** Transfer legs whose reciprocal leg wasn't in this pull (e.g. its account
   *  is closed/off-budget and excluded from the transactions endpoint). One
   *  side of a transfer can't be written safely, so the whole leg is skipped. */
  skippedTransfersIncomplete: number
  /** Transfer pairs where the two mapped YDB accounts don't share a currency
   *  — `validateTransactionWrite` would reject this, so it's caught here
   *  instead of failing the whole batch partway through the commit. */
  skippedTransfersCrossCurrency: number
  /** Tombstones from a delta response. */
  skippedDeleted: number
  /** Rows on a YNAB account with no mapping — reported, never guessed at. */
  skippedUnmappedAccounts: string[]
}

/** The subset of the Prisma client the filter functions need, so they can be
 *  called with either `prisma` or an interactive-transaction client. */
type TransactionReader = {
  transaction: {
    findMany(args: {
      where: { ynabId: { in: string[] } }
      select: { ynabId: true }
    }): Promise<{ ynabId: string | null }[]>
  }
}

/**
 * Drop rows whose `ynabId` is already in the ledger.
 *
 * Takes the client as an argument so the commit path can re-run this *inside*
 * its write transaction. That matters because `createMany({ skipDuplicates })`
 * is not supported on SQLite — Prisma rejects it at the type level — so the
 * belt-and-suspenders layer the design called for has to come from somewhere
 * else. Re-filtering inside the transaction is a strictly stronger guarantee
 * on SQLite than skipDuplicates would have been: SQLite serialises writers, so
 * no row can be inserted between this read and the insert that follows it. The
 * `ynabId` unique constraint remains the hard backstop underneath.
 */
export async function filterAlreadyImported<T extends { ynabId: string }>(
  client: TransactionReader,
  rows: T[],
): Promise<{ rows: T[]; skipped: number }> {
  if (rows.length === 0) return { rows, skipped: 0 }
  const existing = await client.transaction.findMany({
    where: { ynabId: { in: rows.map((r) => r.ynabId) } },
    select: { ynabId: true },
  })
  const seen = new Set(existing.map((r) => r.ynabId))
  const kept = rows.filter((r) => !seen.has(r.ynabId))
  return { rows: kept, skipped: rows.length - kept.length }
}

/**
 * Same idea as `filterAlreadyImported`, for transfer pairs: if *either* side's
 * `ynabId` is already in the ledger, drop the whole pair rather than risk
 * writing a duplicate or orphaned second leg.
 */
export async function filterAlreadyImportedTransfers(
  client: TransactionReader,
  transfers: PlannedTransfer[],
): Promise<{ transfers: PlannedTransfer[]; skipped: number }> {
  if (transfers.length === 0) return { transfers, skipped: 0 }
  const allIds = transfers.flatMap((t) => [t.side1.ynabId, t.side2.ynabId])
  const existing = await client.transaction.findMany({
    where: { ynabId: { in: allIds } },
    select: { ynabId: true },
  })
  const seen = new Set(existing.map((r) => r.ynabId))
  const kept = transfers.filter((t) => !seen.has(t.side1.ynabId) && !seen.has(t.side2.ynabId))
  return { transfers: kept, skipped: transfers.length - kept.length }
}

/** Read the persisted account map, tolerating a hand-edited/absent Setting. */
export async function readAccountMap(): Promise<YnabAccountMap> {
  const row = await prisma.setting.findUnique({ where: { key: YNAB_ACCOUNT_MAP_KEY } })
  if (!row?.value) return {}
  try {
    const parsed = JSON.parse(row.value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: YnabAccountMap = {}
    for (const [ynabId, ydbId] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(ydbId)
      if (Number.isInteger(n) && n > 0) out[ynabId] = n
    }
    return out
  } catch {
    return {}
  }
}

export async function readServerKnowledge(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: YNAB_SERVER_KNOWLEDGE_KEY } })
  const trimmed = row?.value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Validate a client-supplied account map: every value must name a real YDB
 * account. Returns an error string, or null when the map is usable.
 *
 * Deliberately strict — a stale mapping pointing at a deleted account would
 * otherwise fail deep inside the commit with a foreign-key error after some
 * rows had already been written.
 */
export async function validateAccountMap(map: unknown): Promise<{ error: string } | null> {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return { error: 'accountMap must be an object of { ynabAccountId: ydbAccountId }' }
  }
  const ydbIds = [...new Set(Object.values(map as Record<string, unknown>).map(Number))]
  if (ydbIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    return { error: 'accountMap values must be YDB account ids' }
  }
  if (ydbIds.length === 0) {
    return { error: 'Map at least one YNAB account to a YDB account before importing' }
  }
  const found = await prisma.account.findMany({
    where: { id: { in: ydbIds } },
    select: { id: true },
  })
  const foundIds = new Set(found.map((a) => a.id))
  const missing = ydbIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) {
    return { error: `Mapped YDB account(s) no longer exist: ${missing.join(', ')}` }
  }
  return null
}

/**
 * YNAB's display name for a transaction. `payee_name` is the intended source
 * but the API allows null (and does return null on some rows), while YDB's
 * `description` is non-nullable and is what the ledger renders — so fall back
 * to the memo, then to a clearly-synthetic placeholder rather than writing an
 * empty string that reads as a rendering bug.
 */
export function describeYnabTransaction(t: YnabTransaction): string {
  const payee = t.payee_name?.trim()
  if (payee) return payee
  const memo = t.memo?.trim()
  if (memo) return memo
  return '(no payee)'
}

/**
 * Turn one YNAB transaction into a YDB row.
 *
 * For a regular (non-transfer) row, `transactionType` is derived from the
 * converted sign, never from YNAB metadata: YNAB outflows are negative
 * milliunits and inflows positive, which is already YDB's convention, so
 * debit/credit follows directly and can't contradict the amount. Zero-amount
 * rows (YNAB does produce them) are classified `credit`, the only type whose
 * rule permits zero.
 *
 * When `counterpartAccountId` is supplied, the row is one side of a transfer:
 * `transactionType` is forced to `'transfer'` and the sign is left exactly as
 * YNAB reported it (`validateTransactionWrite` allows any sign for transfers,
 * and the two sides must keep opposite signs for account sums to balance).
 */
export function mapYnabTransaction(
  t: YnabTransaction,
  accountId: number,
  counterpartAccountId?: number,
): PlannedRow {
  const amount = milliunitsToCents(t.amount)
  const description = describeYnabTransaction(t)
  return {
    ynabId: t.id,
    // YNAB dates are plain `YYYY-MM-DD` with no zone. Parse at UTC midnight so
    // the stored date can't drift a day either way from the server's zone.
    date: new Date(`${t.date}T00:00:00.000Z`),
    amount,
    description,
    originalDescription: description,
    transactionType: counterpartAccountId != null ? 'transfer' : amount >= 0 ? 'credit' : 'debit',
    category: t.category_name?.trim() || UNCATEGORIZED,
    accountId,
    ynabAccountName: t.account_name,
    ...(counterpartAccountId != null && { transferCounterpartAccountId: counterpartAccountId }),
  }
}

/**
 * Fetch from YNAB and resolve everything that would be imported.
 *
 * Idempotency, in three independent layers so no single one is load-bearing:
 *   1. the `last_knowledge_of_server` delta cursor, so YNAB mostly returns
 *      nothing on a rerun;
 *   2. this pre-filter against existing `ynabId`s, which also covers the case
 *      where the cursor was lost or a full pull was forced — and which the
 *      commit path repeats inside its write transaction;
 *   3. the `Transaction.ynabId` unique constraint at the database, which holds
 *      even if 1 and 2 are both wrong.
 */
export async function planYnabImport(map: YnabAccountMap): Promise<ImportPlan> {
  const serverKnowledgeIn = await readServerKnowledge()
  const { transactions, serverKnowledge, skippedDeleted } = await fetchYnabTransactions(serverKnowledgeIn)

  const regularLegs = transactions.filter((t) => t.transfer_account_id == null)
  const transferLegs = transactions.filter((t) => t.transfer_account_id != null)

  const unmapped = new Set<string>()
  const mapped: PlannedRow[] = []
  for (const t of regularLegs) {
    const accountId = map[t.account_id]
    if (accountId == null) {
      unmapped.add(t.account_name)
      continue
    }
    mapped.push(mapYnabTransaction(t, accountId))
  }

  // Pair transfer legs by transfer_transaction_id — exact, not a date/amount
  // heuristic. Both legs of every transfer are present in the same
  // budget-level pull, so no second fetch is needed. `processed` ensures each
  // pair is only turned into a PlannedTransfer once (the API returns both
  // legs independently, each pointing at the other).
  const byId = new Map(transferLegs.map((t) => [t.id, t]))
  const processed = new Set<string>()
  const transfers: PlannedTransfer[] = []
  let skippedTransfersIncomplete = 0
  let skippedTransfersCrossCurrency = 0

  // Currencies are only needed if there's at least one transfer to check, and
  // loaded once regardless of how many pairs need it.
  let currencyById: Map<number, string> | null = null
  const ydbIds = [...new Set(Object.values(map))]

  for (const leg of transferLegs) {
    if (processed.has(leg.id)) continue
    processed.add(leg.id)

    const counterpart = leg.transfer_transaction_id ? byId.get(leg.transfer_transaction_id) : undefined
    if (!counterpart) {
      skippedTransfersIncomplete++
      continue
    }
    processed.add(counterpart.id)

    const legAccountId = map[leg.account_id]
    const counterpartAccountId = map[counterpart.account_id]
    if (legAccountId == null) unmapped.add(leg.account_name)
    if (counterpartAccountId == null) unmapped.add(counterpart.account_name)
    if (legAccountId == null || counterpartAccountId == null) continue

    if (!currencyById) {
      const rows = await prisma.account.findMany({
        where: { id: { in: ydbIds } },
        select: { id: true, currency: true },
      })
      currencyById = new Map(rows.map((a) => [a.id, a.currency]))
    }
    if (currencyById.get(legAccountId) !== currencyById.get(counterpartAccountId)) {
      skippedTransfersCrossCurrency++
      continue
    }

    transfers.push({
      side1: mapYnabTransaction(leg, legAccountId, counterpartAccountId),
      side2: mapYnabTransaction(counterpart, counterpartAccountId, legAccountId),
    })
  }

  // Layer 2: drop anything already in the ledger.
  const { rows, skipped: rowsSkipped } = await filterAlreadyImported(prisma, mapped)
  const { transfers: keptTransfers, skipped: transfersSkipped } = await filterAlreadyImportedTransfers(
    prisma,
    transfers,
  )

  return {
    rows,
    transfers: keptTransfers,
    serverKnowledge,
    skippedAlreadyImported: rowsSkipped + transfersSkipped,
    skippedTransfersIncomplete,
    skippedTransfersCrossCurrency,
    skippedDeleted,
    skippedUnmappedAccounts: [...unmapped].sort(),
  }
}

export type ImportSummary = {
  count: number
  transfersCount: number
  accountBreakdown: { accountName: string; count: number }[]
  dateRange: [string, string] | null
  categories: number
  skippedAlreadyImported: number
  skippedTransfersIncomplete: number
  skippedTransfersCrossCurrency: number
  skippedDeleted: number
  skippedUnmappedAccounts: string[]
}

/** The confirm-modal payload: enough to sanity-check a pull without shipping
 *  every row to the client. */
export function summarisePlan(plan: ImportPlan): ImportSummary {
  const allRows: PlannedRow[] = [...plan.rows, ...plan.transfers.flatMap((t) => [t.side1, t.side2])]

  const byAccount = new Map<string, number>()
  for (const r of allRows) {
    byAccount.set(r.ynabAccountName, (byAccount.get(r.ynabAccountName) ?? 0) + 1)
  }

  const dates = allRows.map((r) => r.date.getTime())
  const dateRange: [string, string] | null =
    dates.length === 0
      ? null
      : [
          new Date(Math.min(...dates)).toISOString().split('T')[0],
          new Date(Math.max(...dates)).toISOString().split('T')[0],
        ]

  return {
    count: allRows.length,
    transfersCount: plan.transfers.length,
    accountBreakdown: [...byAccount.entries()]
      .map(([accountName, count]) => ({ accountName, count }))
      .sort((a, b) => b.count - a.count || a.accountName.localeCompare(b.accountName)),
    dateRange,
    categories: new Set(allRows.map((r) => r.category)).size,
    skippedAlreadyImported: plan.skippedAlreadyImported,
    skippedTransfersIncomplete: plan.skippedTransfersIncomplete,
    skippedTransfersCrossCurrency: plan.skippedTransfersCrossCurrency,
    skippedDeleted: plan.skippedDeleted,
    skippedUnmappedAccounts: plan.skippedUnmappedAccounts,
  }
}
