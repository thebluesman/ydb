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
import {
  computeYnabFingerprint,
  fetchYnabTransactions,
  milliunitsToCents,
  YNAB_FINGERPRINT_VERSION,
  type YnabTransaction,
} from '@/lib/ynab'

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
  /** ADR-0005 change-detection snapshot — see `computeYnabFingerprint`. */
  ynabFingerprint: string
}

/** Two linked rows for one YNAB transfer (which includes credit card and loan
 *  payments). Each side carries its own `ynabId` so idempotency works the
 *  same way as for a regular row — either side alone is enough to detect
 *  "already imported". */
export type PlannedTransfer = {
  side1: PlannedRow
  side2: PlannedRow
}

/** One row for the "changed"/"deleted in YNAB" report (ADR-0004) — enough
 *  identity to find and reconcile the row by hand, without shipping the full
 *  row to the client. */
export type YnabChangeReportItem = {
  ynabId: string
  date: string
  description: string
  amount: number
  accountName: string
}

export type ImportPlan = {
  rows: PlannedRow[]
  transfers: PlannedTransfer[]
  serverKnowledge: string
  /** Rows/transfer-pairs YNAB returned that were already in the ledger by
   *  `ynabId` *and* whose frozen `ynabFingerprint` snapshot (ADR-0005)
   *  matches what YNAB reports now — a harmless re-delivery. Rows whose
   *  fingerprint differs are reported in `changedInYnab` instead. */
  skippedAlreadyImported: number
  /** Transfer legs whose reciprocal leg wasn't in this pull (e.g. its account
   *  is closed/off-budget and excluded from the transactions endpoint). One
   *  side of a transfer can't be written safely, so the whole leg is skipped. */
  skippedTransfersIncomplete: number
  /** Transfer pairs where the two mapped YDB accounts don't share a currency
   *  — `validateTransactionWrite` would reject this, so it's caught here
   *  instead of failing the whole batch partway through the commit. */
  skippedTransfersCrossCurrency: number
  /** Transfer pairs where both YNAB accounts map to the *same* YDB account —
   *  `validateTransactionWrite` would reject "counterpart cannot be the same
   *  account as the source", so it's caught here with a clear cause instead
   *  of surfacing as a misleading sign-rule violation. */
  skippedTransfersSameAccount: number
  /** Already-imported rows/transfer legs whose stored content differs from
   *  what YNAB now reports for the same `ynabId` — edited in YNAB since
   *  import. Never auto-applied (ADR-0004); surfaced for manual reconcile. */
  changedInYnab: YnabChangeReportItem[]
  /** Tombstones from a delta response that match an already-imported row.
   *  Never auto-deleted (ADR-0004); a tombstone for a `ynabId` never imported
   *  carries no useful identity and is dropped silently, not counted here. */
  deletedInYnab: YnabChangeReportItem[]
  /** Transfer pairs where exactly one leg's `ynabId` is already in the
   *  ledger and the other is not — e.g. the counterpart leg was deleted from
   *  YDB directly (DELETE only cascades a locally-created counterpart, never
   *  an imported one — see app/api/transactions/[id]/route.ts) rather than
   *  through a re-import. This is NOT a duplicate: writing the pull's fresh
   *  pair would violate the `ynabId` unique constraint on the present leg,
   *  but silently treating it as "already imported" (as a naive either-side
   *  existence check would) leaves the account permanently off by the
   *  missing leg's amount with no signal. Reported so Shyam can either
   *  delete the surviving leg (so a future pull re-imports the pair whole)
   *  or manually recreate the missing one — never auto-healed (ADR-0004). */
  orphanedTransferLegs: YnabChangeReportItem[]
  /** Rows on a YNAB account with no mapping — reported, never guessed at. */
  skippedUnmappedAccounts: string[]
  /** `accountId -> currency` for every mapped YDB account, built once while
   *  checking transfer pairs for cross-currency mismatches. `null` when the
   *  pull had no transfer legs to check. The commit route reuses this so
   *  `validateTransactionWrite` doesn't re-fetch each transfer leg's account
   *  currency it already looked up here (finding 6, docs/ynab-import-fix-plan.md). */
  currencyById: Map<number, string> | null
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

// SQLite caps bound parameters per statement at 32766. A single `ynabId IN
// (...)` query stays comfortably under that for any realistic pull, but the
// first full-history import (ADR-0003) is the one case with thousands of
// rows in one batch, so every `IN`-over-the-whole-pull query in this file
// chunks through this rather than assume it never gets there.
const YNAB_ID_QUERY_CHUNK_SIZE = 5_000

async function findManyChunked<T>(
  ynabIds: string[],
  findMany: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ynabIds.length === 0) return []
  const out: T[] = []
  for (let i = 0; i < ynabIds.length; i += YNAB_ID_QUERY_CHUNK_SIZE) {
    out.push(...(await findMany(ynabIds.slice(i, i + YNAB_ID_QUERY_CHUNK_SIZE))))
  }
  return out
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
  const existing = await findManyChunked(
    rows.map((r) => r.ynabId),
    (chunk) => client.transaction.findMany({ where: { ynabId: { in: chunk } }, select: { ynabId: true } }),
  )
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
  const existing = await findManyChunked(allIds, (chunk) =>
    client.transaction.findMany({ where: { ynabId: { in: chunk } }, select: { ynabId: true } }),
  )
  const seen = new Set(existing.map((r) => r.ynabId))
  const kept = transfers.filter((t) => !seen.has(t.side1.ynabId) && !seen.has(t.side2.ynabId))
  return { transfers: kept, skipped: transfers.length - kept.length }
}

/** The fields a stored row needs for the ADR-0005 fingerprint comparison —
 *  just the frozen snapshot, never any of the row's live/editable columns.
 *  Comparing against the live row (ADR-0004's original approach) meant any
 *  local edit — recategorising, most commonly — permanently and falsely
 *  read as a YNAB-side change; comparing snapshot-to-snapshot means a local
 *  edit is invisible to detection by construction, for every field. */
type ExistingFingerprint = {
  ynabId: string | null
  ynabFingerprint: string | null
}

/** A row with no snapshot (imported before this migration) or one stamped
 *  with an older fingerprint version is treated as unchanged — the version
 *  check keeps a future fingerprint field-set change from flagging every
 *  existing row as "changed in YNAB" the next time it's pulled. */
function fingerprintDiffers(candidate: PlannedRow, existing: ExistingFingerprint): boolean {
  if (existing.ynabFingerprint == null) return false
  if (!existing.ynabFingerprint.startsWith(`${YNAB_FINGERPRINT_VERSION}|`)) return false
  return existing.ynabFingerprint !== candidate.ynabFingerprint
}

function toReportItem(row: PlannedRow): YnabChangeReportItem {
  return {
    ynabId: row.ynabId,
    date: row.date.toISOString().split('T')[0],
    description: row.description,
    amount: row.amount,
    accountName: row.ynabAccountName,
  }
}

const FINGERPRINT_SELECT = {
  ynabId: true,
  ynabFingerprint: true,
} as const

/**
 * Split regular rows into ones to write (never seen before) vs. ones already
 * in the ledger — classifying the latter as an unchanged re-delivery
 * (`duplicates`) or a YNAB-side edit (`changed`), per ADR-0004. Always called
 * with `prisma` directly: this runs once at plan time, never inside the
 * commit transaction.
 */
async function partitionByExisting(
  rows: PlannedRow[],
): Promise<{ toWrite: PlannedRow[]; duplicates: number; changed: YnabChangeReportItem[] }> {
  if (rows.length === 0) return { toWrite: rows, duplicates: 0, changed: [] }
  const existing = await findManyChunked(
    rows.map((r) => r.ynabId),
    (chunk) =>
      prisma.transaction.findMany({ where: { ynabId: { in: chunk } }, select: FINGERPRINT_SELECT }) as Promise<
        ExistingFingerprint[]
      >,
  )

  const existingById = new Map(existing.filter((r) => r.ynabId != null).map((r) => [r.ynabId as string, r]))
  const toWrite: PlannedRow[] = []
  let duplicates = 0
  const changed: YnabChangeReportItem[] = []
  for (const row of rows) {
    const found = existingById.get(row.ynabId)
    if (!found) {
      toWrite.push(row)
    } else if (fingerprintDiffers(row, found)) {
      changed.push(toReportItem(row))
    } else {
      duplicates++
    }
  }
  return { toWrite, duplicates, changed }
}

/** Same idea as `partitionByExisting`, at transfer-pair granularity: a pair
 *  already in the ledger (both legs present) is dropped whole (never
 *  re-written a leg at a time), and counts as one duplicate unless at least
 *  one of its legs' content differs from what's stored, in which case the
 *  differing leg(s) are reported as changed. A pair with exactly one leg
 *  present is a distinct, worse case — see `orphanedTransferLegs` on
 *  `ImportPlan` — and is never counted as a duplicate or written. */
async function partitionTransfersByExisting(transfers: PlannedTransfer[]): Promise<{
  toWrite: PlannedTransfer[]
  duplicates: number
  changed: YnabChangeReportItem[]
  orphaned: YnabChangeReportItem[]
}> {
  if (transfers.length === 0) return { toWrite: transfers, duplicates: 0, changed: [], orphaned: [] }
  const legs = transfers.flatMap((t) => [t.side1, t.side2])
  const existing = await findManyChunked(
    legs.map((r) => r.ynabId),
    (chunk) =>
      prisma.transaction.findMany({ where: { ynabId: { in: chunk } }, select: FINGERPRINT_SELECT }) as Promise<
        ExistingFingerprint[]
      >,
  )
  const existingById = new Map(existing.filter((r) => r.ynabId != null).map((r) => [r.ynabId as string, r]))

  const toWrite: PlannedTransfer[] = []
  let duplicates = 0
  const changed: YnabChangeReportItem[] = []
  const orphaned: YnabChangeReportItem[] = []
  for (const t of transfers) {
    const found1 = existingById.get(t.side1.ynabId)
    const found2 = existingById.get(t.side2.ynabId)
    if (!found1 && !found2) {
      toWrite.push(t)
      continue
    }
    if (!found1 || !found2) {
      // Exactly one leg is present — the ledger holds an orphan half of this
      // transfer (its counterpart was deleted outside a re-import; DELETE
      // only cascades a locally-created counterpart, never an imported one —
      // app/api/transactions/[id]/route.ts). Neither a duplicate nor a
      // "changed" edit: report distinctly and never write, since the present
      // leg's ynabId already occupies the unique constraint.
      orphaned.push(toReportItem(found1 ? t.side1 : t.side2))
      continue
    }
    let anyChanged = false
    if (fingerprintDiffers(t.side1, found1)) {
      changed.push(toReportItem(t.side1))
      anyChanged = true
    }
    if (fingerprintDiffers(t.side2, found2)) {
      changed.push(toReportItem(t.side2))
      anyChanged = true
    }
    if (!anyChanged) duplicates++
  }
  return { toWrite, duplicates, changed, orphaned }
}

/**
 * Match YNAB tombstones against the ledger (ADR-0004). Only tombstones whose
 * `ynabId` is actually in YDB are reported — a tombstone for a transaction
 * never imported has no useful identity, and reporting it would just be
 * noise. Identity fields come from the stored YDB row, not the tombstone,
 * since a delta-response tombstone is not guaranteed to carry full content.
 */
async function detectDeletions(deletedTransactions: YnabTransaction[]): Promise<YnabChangeReportItem[]> {
  if (deletedTransactions.length === 0) return []
  const existing = await findManyChunked(
    deletedTransactions.map((t) => t.id),
    (chunk) =>
      prisma.transaction.findMany({
        where: { ynabId: { in: chunk } },
        select: { ynabId: true, date: true, amount: true, description: true, accountId: true },
      }),
  )
  if (existing.length === 0) return []

  const accountIds = [...new Set(existing.map((r) => r.accountId))]
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true } })
  const nameById = new Map(accounts.map((a) => [a.id, a.name]))

  return existing
    .filter((r): r is typeof r & { ynabId: string } => r.ynabId != null)
    .map((r) => ({
      ynabId: r.ynabId,
      date: r.date.toISOString().split('T')[0],
      description: r.description,
      amount: r.amount,
      accountName: nameById.get(r.accountId) ?? `Account ${r.accountId}`,
    }))
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
 *
 * Known Phase 1 limitation: split transactions. `YnabTransaction` doesn't
 * model `subtransactions[]` (YNAB's per-leg breakdown for a split), so a
 * split parent imports as a single row under the literal category name YNAB
 * gives it, `"Split"` — total amount is correct, but the per-category
 * breakdown YNAB tracked is lost. `t.category_name?.trim() || UNCATEGORIZED`
 * below never falls back for this case since `"Split"` is a non-empty
 * string, so it reads as an honest (if unhelpful) category, not silently as
 * "Uncategorized". See docs/research/ynab-vs-ydb/findings.md for the
 * verified real-budget example this is based on. Mapping `subtransactions[]`
 * onto YDB's existing `parentTransactionId`/`splitLegs` model is a natural
 * Phase 2 (or late Phase 1) addition, not attempted here.
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
    ynabFingerprint: computeYnabFingerprint(t),
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
  const { transactions, serverKnowledge, deletedTransactions } = await fetchYnabTransactions(serverKnowledgeIn)

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
  let skippedTransfersSameAccount = 0

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

    // Two YNAB accounts can legitimately map to the same YDB account for
    // regular rows, but a transfer *between* them collapses to a
    // same-account transfer, which the ledger's sign rules forbid — catch it
    // here rather than let it hit validateTransactionWrite with a misleading
    // "sign rules" error (finding 3, docs/ynab-import-fix-plan.md).
    if (legAccountId === counterpartAccountId) {
      skippedTransfersSameAccount++
      continue
    }

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

  // Layer 2: drop anything already in the ledger, classifying it as an
  // unchanged re-delivery or a YNAB-side edit (ADR-0004) along the way.
  const { toWrite: rows, duplicates: rowDuplicates, changed: rowsChanged } = await partitionByExisting(mapped)
  const {
    toWrite: keptTransfers,
    duplicates: transferDuplicates,
    changed: transfersChanged,
    orphaned: orphanedTransferLegs,
  } = await partitionTransfersByExisting(transfers)
  const deletedInYnab = await detectDeletions(deletedTransactions)

  return {
    rows,
    transfers: keptTransfers,
    serverKnowledge,
    skippedAlreadyImported: rowDuplicates + transferDuplicates,
    skippedTransfersIncomplete,
    skippedTransfersCrossCurrency,
    skippedTransfersSameAccount,
    changedInYnab: [...rowsChanged, ...transfersChanged],
    deletedInYnab,
    orphanedTransferLegs,
    skippedUnmappedAccounts: [...unmapped].sort(),
    currencyById,
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
  skippedTransfersSameAccount: number
  changedInYnab: YnabChangeReportItem[]
  deletedInYnab: YnabChangeReportItem[]
  orphanedTransferLegs: YnabChangeReportItem[]
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
    skippedTransfersSameAccount: plan.skippedTransfersSameAccount,
    changedInYnab: plan.changedInYnab,
    deletedInYnab: plan.deletedInYnab,
    orphanedTransferLegs: plan.orphanedTransferLegs,
    skippedUnmappedAccounts: plan.skippedUnmappedAccounts,
  }
}
