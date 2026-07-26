import { beforeEach, describe, expect, it, vi } from 'vitest'

// Full in-memory fake of the slice of Prisma the planning/commit path touches
// (account, setting, transaction, category, importRecord, $transaction) — same
// pattern as tests/transactionDeleteCascade.test.ts, extended to cover
// planYnabImport and the import route's write transaction so the run-twice
// idempotency test (finding 4, docs/ynab-import-fix-plan.md) can exercise the
// real route handler without a real DB.
type AccountRow = { id: number; currency: string; name: string }
type TxRow = {
  id: number
  ynabId: string | null
  ynabFingerprint: string | null
  date: Date
  accountId: number
  transactionType: string
  amount: number
  category: string
  description: string
  originalDescription: string | null
  transferCounterpartAccountId: number | null
  linkedTransferId: number | null
}

vi.mock('@/lib/prisma', () => {
  const accounts = new Map<number, AccountRow>()
  const settings = new Map<string, string>()
  const transactions = new Map<number, TxRow>()
  const categories = new Map<string, { name: string; color: string }>()
  const importRecords: { filename: string; accountId: number; transactionCount: number }[] = []
  let nextId = 1

  const store = { accounts, settings, transactions, categories, importRecords, resetIds: () => { nextId = 1 } }
  ;(globalThis as unknown as { __ynabStore: typeof store }).__ynabStore = store

  // Ignores `select` and returns every field — harmless for callers that
  // only project a subset, and lets the same fake serve both the narrow
  // `{ ynabId: true }` reads and the fuller ADR-0004 fingerprint reads.
  const accountFindMany = async ({ where }: { where?: { id?: { in: number[] } } } = {}) =>
    where?.id ? where.id.in.map((id) => accounts.get(id)).filter((a): a is AccountRow => a != null) : [...accounts.values()]

  const transactionFindMany = async ({ where }: { where: { ynabId: { in: string[] } } }) => {
    const ids = new Set(where.ynabId.in)
    return [...transactions.values()].filter((t) => t.ynabId != null && ids.has(t.ynabId))
  }

  const txClient = {
    transaction: {
      findMany: transactionFindMany,
      createMany: async ({ data }: { data: Partial<TxRow>[] }) => {
        for (const d of data) {
          const id = nextId++
          transactions.set(id, {
            id,
            ynabId: d.ynabId ?? null,
            ynabFingerprint: d.ynabFingerprint ?? null,
            date: d.date as Date,
            accountId: d.accountId as number,
            transactionType: d.transactionType as string,
            amount: d.amount as number,
            category: d.category as string,
            description: d.description as string,
            originalDescription: d.originalDescription ?? null,
            transferCounterpartAccountId: d.transferCounterpartAccountId ?? null,
            linkedTransferId: null,
          })
        }
        return { count: data.length }
      },
      create: async ({ data }: { data: Partial<TxRow> }) => {
        const id = nextId++
        transactions.set(id, {
          id,
          ynabId: data.ynabId ?? null,
          ynabFingerprint: data.ynabFingerprint ?? null,
          date: data.date as Date,
          accountId: data.accountId as number,
          transactionType: data.transactionType as string,
          amount: data.amount as number,
          category: data.category as string,
          description: data.description as string,
          originalDescription: data.originalDescription ?? null,
          transferCounterpartAccountId: data.transferCounterpartAccountId ?? null,
          linkedTransferId: data.linkedTransferId ?? null,
        })
        return { id }
      },
      update: async ({ where: { id }, data }: { where: { id: number }; data: Partial<TxRow> }) => {
        const row = transactions.get(id)
        if (row) Object.assign(row, data)
      },
    },
    category: {
      upsert: async ({ where: { name }, create }: { where: { name: string }; create: { name: string; color: string } }) => {
        if (!categories.has(name)) categories.set(name, create)
      },
    },
    importRecord: {
      create: async ({ data }: { data: { filename: string; accountId: number; transactionCount: number } }) => {
        importRecords.push(data)
      },
    },
    setting: {
      upsert: async ({ where: { key }, update, create }: { where: { key: string }; update: { value: string }; create: { value: string } }) => {
        settings.set(key, update?.value ?? create.value)
      },
    },
  }

  return {
    prisma: {
      account: { findMany: accountFindMany, findUnique: async ({ where: { id } }: { where: { id: number } }) => accounts.get(id) ?? null },
      setting: {
        findUnique: async ({ where: { key } }: { where: { key: string } }) => {
          const value = settings.get(key)
          return value != null ? { value } : null
        },
      },
      transaction: { findMany: transactionFindMany },
      // Mirrors real Prisma's all-or-nothing $transaction: snapshot the four
      // mutable stores before running the callback and restore them verbatim
      // if it throws, so a forced mid-commit failure can be asserted to
      // leave the store byte-identical to its pre-call state (QA finding:
      // the route's rollback claim was previously untested by this fake).
      $transaction: async (cb: (tx: typeof txClient) => Promise<unknown>) => {
        const snapshot = {
          transactions: new Map(transactions),
          settings: new Map(settings),
          categories: new Map(categories),
          importRecords: [...importRecords],
          nextId,
        }
        try {
          return await cb(txClient)
        } catch (err) {
          transactions.clear()
          for (const [k, v] of snapshot.transactions) transactions.set(k, v)
          settings.clear()
          for (const [k, v] of snapshot.settings) settings.set(k, v)
          categories.clear()
          for (const [k, v] of snapshot.categories) categories.set(k, v)
          importRecords.length = 0
          importRecords.push(...snapshot.importRecords)
          nextId = snapshot.nextId
          throw err
        }
      },
    },
  }
})

vi.mock('@/lib/ynab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ynab')>()
  const fetchYnabTransactions = vi.fn()
  ;(globalThis as unknown as { __fetchYnabTransactions: typeof fetchYnabTransactions }).__fetchYnabTransactions =
    fetchYnabTransactions
  return { ...actual, fetchYnabTransactions }
})

import { milliunitsToCents } from '@/lib/ynab'
import type { YnabTransaction } from '@/lib/ynab'
import {
  UNCATEGORIZED,
  describeYnabTransaction,
  mapYnabTransaction,
  planYnabImport,
  summarisePlan,
  type ImportPlan,
} from '@/lib/ynabImport'
import { validateTransactionWrite } from '@/lib/transactionValidation'

const ynabStore = (
  globalThis as unknown as {
    __ynabStore: {
      accounts: Map<number, AccountRow>
      settings: Map<string, string>
      transactions: Map<number, TxRow>
      categories: Map<string, { name: string; color: string }>
      importRecords: { filename: string; accountId: number; transactionCount: number }[]
      resetIds: () => void
    }
  }
).__ynabStore

const fetchYnabTransactionsMock = (
  globalThis as unknown as {
    __fetchYnabTransactions: ReturnType<typeof vi.fn>
  }
).__fetchYnabTransactions

const testAccounts = ynabStore.accounts
testAccounts.set(1, { id: 1, currency: 'AED', name: 'ENBD' })
testAccounts.set(2, { id: 2, currency: 'AED', name: 'Liv' })

function ynabTx(overrides: Partial<YnabTransaction> = {}): YnabTransaction {
  return {
    id: 'ynab-1',
    date: '2026-07-04',
    amount: -12_345_0,
    memo: null,
    account_id: 'acct-1',
    account_name: 'ENBD',
    payee_name: 'Carrefour',
    category_name: '🛒 Groceries',
    category_id: 'cat-groceries',
    transfer_account_id: null,
    transfer_transaction_id: null,
    deleted: false,
    ...overrides,
  }
}

describe('milliunitsToCents', () => {
  // Anchored on a real response: 2_605_800 milliunits came back as
  // amount_formatted "AED2605.80".
  it('converts the real-world reference amount', () => {
    expect(milliunitsToCents(2_605_800)).toBe(260_580)
  })

  it('preserves sign for outflows', () => {
    expect(milliunitsToCents(-123_450)).toBe(-12_345)
  })

  it('maps zero to zero', () => {
    expect(milliunitsToCents(0)).toBe(0)
  })

  it('rounds a sub-cent amount rather than emitting a fractional cent', () => {
    expect(milliunitsToCents(1_005)).toBe(101)
    expect(milliunitsToCents(1_004)).toBe(100)
    expect(Number.isInteger(milliunitsToCents(1_005))).toBe(true)
  })

  // Documents the asymmetric-rounding assumption noted on milliunitsToCents:
  // Math.round breaks an exact halfway tie towards +Infinity, so a negative
  // and positive tie round differently. Never hit in practice — real YNAB
  // amounts are always multiples of 10 milliunits — but pinned here so a
  // regression (or the assumption breaking) shows up as a failing test.
  it('rounds an exact-halfway negative amount towards +Infinity, asymmetrically with its positive counterpart', () => {
    expect(milliunitsToCents(-1_005)).toBe(-100)
    expect(milliunitsToCents(1_005)).toBe(101)
  })

  it('is total on non-finite input, so a bad amount cannot become NaN cents', () => {
    expect(milliunitsToCents(Number.NaN)).toBe(0)
    expect(milliunitsToCents(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('describeYnabTransaction', () => {
  it('prefers the payee name', () => {
    expect(describeYnabTransaction(ynabTx())).toBe('Carrefour')
  })

  it('falls back to the memo when payee_name is null', () => {
    expect(describeYnabTransaction(ynabTx({ payee_name: null, memo: 'ATM withdrawal' }))).toBe(
      'ATM withdrawal',
    )
  })

  it('never returns an empty description', () => {
    expect(describeYnabTransaction(ynabTx({ payee_name: '   ', memo: null }))).toBe('(no payee)')
  })
})

describe('mapYnabTransaction', () => {
  it('maps an outflow to a negative debit', () => {
    const row = mapYnabTransaction(ynabTx({ amount: -123_450 }), 7)
    expect(row.amount).toBe(-12_345)
    expect(row.transactionType).toBe('debit')
    expect(row.accountId).toBe(7)
    expect(row.category).toBe('🛒 Groceries')
    expect(row.ynabId).toBe('ynab-1')
  })

  it('maps an inflow to a positive credit', () => {
    const row = mapYnabTransaction(ynabTx({ amount: 500_000 }), 1)
    expect(row.amount).toBe(50_000)
    expect(row.transactionType).toBe('credit')
  })

  it('classifies a zero amount as credit — the only type whose rule allows zero', () => {
    const row = mapYnabTransaction(ynabTx({ amount: 0 }), 1)
    expect(row.amount).toBe(0)
    expect(row.transactionType).toBe('credit')
  })

  it('falls back to Uncategorized when YNAB sends a null category', () => {
    expect(mapYnabTransaction(ynabTx({ category_name: null }), 1).category).toBe(UNCATEGORIZED)
  })

  // Known Phase 1 limitation (docs/research/ynab-vs-ydb/findings.md): a split
  // transaction's per-leg breakdown isn't modelled, so the parent imports as
  // one row under YNAB's literal "Split" category with the correct total
  // amount — balances stay right, category analysis just can't see the legs.
  it('imports a split-transaction parent as one row under the literal "Split" category, with the correct total', () => {
    const row = mapYnabTransaction(
      ynabTx({ id: 'split-1', category_name: 'Split', amount: -147_060 }),
      1,
    )
    expect(row.category).toBe('Split')
    expect(row.amount).toBe(-14_706)
  })

  it('parses the plain YNAB date at UTC midnight so it cannot drift a day', () => {
    const row = mapYnabTransaction(ynabTx({ date: '2026-07-04' }), 1)
    expect(row.date.toISOString()).toBe('2026-07-04T00:00:00.000Z')
  })

  it('copies the description into originalDescription', () => {
    const row = mapYnabTransaction(ynabTx(), 1)
    expect(row.originalDescription).toBe(row.description)
  })

  // The invariant that matters most: whatever YNAB sends, the derived
  // transactionType/amount pair must satisfy lib/accounts.ts's sign rules, so
  // validateTransactionWrite in the import route never has to reject a row.
  it('always produces a row that satisfies the ledger sign rules', async () => {
    const amounts = [-1_000_000, -123_450, -10, 0, 10, 123_450, 1_000_000]
    for (const amount of amounts) {
      const row = mapYnabTransaction(ynabTx({ amount }), 1)
      const invalid = await validateTransactionWrite({
        transactionType: row.transactionType,
        amount: row.amount,
        accountId: row.accountId,
        transferCounterpartAccountId: null,
      })
      expect(invalid, `amount ${amount} produced ${row.transactionType}`).toBeNull()
    }
  })

  // Credit card/loan payments are transfers in YNAB, not plain debits — this
  // is the mapping the earlier version of the importer got wrong by dropping
  // transfer legs entirely (see docs/research/ynab-vs-ydb/findings.md).
  it('marks a row as a transfer when a counterpart account is supplied, keeping the raw sign', () => {
    const row = mapYnabTransaction(ynabTx({ amount: -364_044 }), 1, 4)
    expect(row.transactionType).toBe('transfer')
    expect(row.amount).toBe(-36_404)
    expect(row.transferCounterpartAccountId).toBe(4)
  })

  it('leaves transferCounterpartAccountId unset for a regular row', () => {
    const row = mapYnabTransaction(ynabTx(), 1)
    expect(row.transferCounterpartAccountId).toBeUndefined()
  })

  it('produces a transfer row pair that both satisfy validateTransactionWrite', async () => {
    const outLeg = mapYnabTransaction(ynabTx({ id: 'out', amount: -500_000 }), 1, 2)
    const inLeg = mapYnabTransaction(ynabTx({ id: 'in', amount: 500_000, account_id: 'acct-2' }), 2, 1)
    for (const row of [outLeg, inLeg]) {
      const invalid = await validateTransactionWrite({
        transactionType: row.transactionType,
        amount: row.amount,
        accountId: row.accountId,
        transferCounterpartAccountId: row.transferCounterpartAccountId ?? null,
      })
      expect(invalid).toBeNull()
    }
  })
})

describe('summarisePlan', () => {
  function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
    return {
      rows: [],
      transfers: [],
      serverKnowledge: '1168',
      skippedAlreadyImported: 0,
      skippedTransfersIncomplete: 0,
      skippedTransfersCrossCurrency: 0,
      skippedTransfersSameAccount: 0,
      changedInYnab: [],
      deletedInYnab: [],
      orphanedTransferLegs: [],
      skippedUnmappedAccounts: [],
      currencyById: null,
      ...overrides,
    }
  }

  it('reports an empty plan without inventing a date range', () => {
    const s = summarisePlan(plan())
    expect(s.count).toBe(0)
    expect(s.dateRange).toBeNull()
    expect(s.accountBreakdown).toEqual([])
  })

  it('counts per account, spans the date range, and counts distinct categories', () => {
    const rows = [
      mapYnabTransaction(ynabTx({ id: 'a', date: '2026-05-23', account_name: 'ENBD' }), 1),
      mapYnabTransaction(ynabTx({ id: 'b', date: '2026-07-04', account_name: 'ENBD' }), 1),
      mapYnabTransaction(
        ynabTx({ id: 'c', date: '2026-06-01', account_name: 'Liv', category_name: '✈️ Travel' }),
        2,
      ),
    ]
    const s = summarisePlan(plan({ rows }))
    expect(s.count).toBe(3)
    expect(s.dateRange).toEqual(['2026-05-23', '2026-07-04'])
    expect(s.categories).toBe(2)
    expect(s.accountBreakdown).toEqual([
      { accountName: 'ENBD', count: 2 },
      { accountName: 'Liv', count: 1 },
    ])
  })

  // A transfer pair contributes two rows to the total count and to each
  // side's own account breakdown — this is what makes the confirm modal's
  // "N transactions will be imported" match what actually lands in the DB.
  it('counts both sides of a transfer pair, and reports transfersCount separately', () => {
    const transfers = [
      {
        side1: mapYnabTransaction(
          ynabTx({ id: 'out', date: '2026-06-17', account_name: 'ENBD', amount: -500_000 }),
          1,
          2,
        ),
        side2: mapYnabTransaction(
          ynabTx({ id: 'in', date: '2026-06-17', account_name: 'U by Emaar', amount: 500_000, account_id: 'acct-2' }),
          2,
          1,
        ),
      },
    ]
    const s = summarisePlan(plan({ transfers }))
    expect(s.count).toBe(2)
    expect(s.transfersCount).toBe(1)
    expect(s.accountBreakdown).toEqual([
      { accountName: 'ENBD', count: 1 },
      { accountName: 'U by Emaar', count: 1 },
    ])
  })

  it('passes the skip counts and ADR-0004 change/delete reports through for the confirm dialog', () => {
    const changedItem = { ynabId: 'x', date: '2026-07-01', description: 'Edited', amount: -100, accountName: 'ENBD' }
    const deletedItem = { ynabId: 'y', date: '2026-07-02', description: 'Gone', amount: -200, accountName: 'ENBD' }
    const s = summarisePlan(
      plan({
        skippedAlreadyImported: 4,
        skippedTransfersIncomplete: 3,
        skippedTransfersCrossCurrency: 2,
        changedInYnab: [changedItem],
        deletedInYnab: [deletedItem],
        skippedUnmappedAccounts: ['Car Loan'],
      }),
    )
    expect(s.skippedAlreadyImported).toBe(4)
    expect(s.skippedTransfersIncomplete).toBe(3)
    expect(s.skippedTransfersCrossCurrency).toBe(2)
    expect(s.changedInYnab).toEqual([changedItem])
    expect(s.deletedInYnab).toEqual([deletedItem])
    expect(s.skippedUnmappedAccounts).toEqual(['Car Loan'])
  })
})

function resetStore() {
  ynabStore.transactions.clear()
  ynabStore.settings.clear()
  ynabStore.categories.clear()
  ynabStore.importRecords.length = 0
  ynabStore.resetIds()
  fetchYnabTransactionsMock.mockReset()
}

function transferLeg(overrides: Partial<YnabTransaction> = {}): YnabTransaction {
  return ynabTx({ transfer_account_id: 'transfer-acct', transfer_transaction_id: null, ...overrides })
}

describe('planYnabImport — transfer pairing', () => {
  beforeEach(() => {
    resetStore()
    ynabStore.accounts.set(1, { id: 1, currency: 'AED', name: 'ENBD' })
    ynabStore.accounts.set(2, { id: 2, currency: 'AED', name: 'Liv' })
    ynabStore.accounts.set(3, { id: 3, currency: 'USD', name: 'US Card' })
  })

  it('pairs a matched leg/counterpart into one PlannedTransfer, dropped from the regular skip counts', async () => {
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', amount: -500_000, transfer_transaction_id: 'in' })
    const inLeg = transferLeg({ id: 'in', account_id: 'acct-2', amount: 500_000, transfer_transaction_id: 'out' })
    fetchYnabTransactionsMock.mockResolvedValue({ transactions: [outLeg, inLeg], serverKnowledge: '1', deletedTransactions: [] })

    const plan = await planYnabImport({ 'acct-1': 1, 'acct-2': 2 })
    expect(plan.transfers).toHaveLength(1)
    expect(plan.transfers[0].side1.ynabId).toBe('out')
    expect(plan.transfers[0].side2.ynabId).toBe('in')
    expect(plan.skippedTransfersIncomplete).toBe(0)
    expect(plan.skippedTransfersCrossCurrency).toBe(0)
    expect(plan.skippedTransfersSameAccount).toBe(0)
  })

  it('skips an orphan leg whose counterpart is absent from the pull (e.g. a closed account)', async () => {
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', amount: -500_000, transfer_transaction_id: 'missing' })
    fetchYnabTransactionsMock.mockResolvedValue({ transactions: [outLeg], serverKnowledge: '1', deletedTransactions: [] })

    const plan = await planYnabImport({ 'acct-1': 1, 'acct-2': 2 })
    expect(plan.transfers).toHaveLength(0)
    expect(plan.skippedTransfersIncomplete).toBe(1)
  })

  it('reports an unmapped counterpart account by name and skips the pair', async () => {
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', account_name: 'ENBD', amount: -500_000, transfer_transaction_id: 'in' })
    const inLeg = transferLeg({ id: 'in', account_id: 'acct-unmapped', account_name: 'Unmapped Card', amount: 500_000, transfer_transaction_id: 'out' })
    fetchYnabTransactionsMock.mockResolvedValue({ transactions: [outLeg, inLeg], serverKnowledge: '1', deletedTransactions: [] })

    const plan = await planYnabImport({ 'acct-1': 1 })
    expect(plan.transfers).toHaveLength(0)
    expect(plan.skippedUnmappedAccounts).toContain('Unmapped Card')
  })

  it('skips a cross-currency transfer pair rather than let it fail deep in the commit', async () => {
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', amount: -500_000, transfer_transaction_id: 'in' })
    const inLeg = transferLeg({ id: 'in', account_id: 'acct-3', amount: 500_000, transfer_transaction_id: 'out' })
    fetchYnabTransactionsMock.mockResolvedValue({ transactions: [outLeg, inLeg], serverKnowledge: '1', deletedTransactions: [] })

    const plan = await planYnabImport({ 'acct-1': 1, 'acct-3': 3 })
    expect(plan.transfers).toHaveLength(0)
    expect(plan.skippedTransfersCrossCurrency).toBe(1)
  })

  // finding 3, docs/ynab-import-fix-plan.md: two YNAB accounts mapped to the
  // same YDB account produce a same-account transfer, which
  // validateTransactionWrite would reject with a misleading sign-rule error —
  // planYnabImport must catch it first.
  it('skips a transfer where both YNAB accounts map to the same YDB account', async () => {
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', amount: -500_000, transfer_transaction_id: 'in' })
    const inLeg = transferLeg({ id: 'in', account_id: 'acct-1b', amount: 500_000, transfer_transaction_id: 'out' })
    fetchYnabTransactionsMock.mockResolvedValue({ transactions: [outLeg, inLeg], serverKnowledge: '1', deletedTransactions: [] })

    const plan = await planYnabImport({ 'acct-1': 1, 'acct-1b': 1 })
    expect(plan.transfers).toHaveLength(0)
    expect(plan.skippedTransfersSameAccount).toBe(1)
  })
})

describe('POST /api/ynab/import — idempotency', () => {
  beforeEach(() => {
    resetStore()
    ynabStore.accounts.set(1, { id: 1, currency: 'AED', name: 'ENBD' })
    ynabStore.accounts.set(2, { id: 2, currency: 'AED', name: 'Liv' })
  })

  async function runImport(accountMap: Record<string, number>) {
    const { POST } = await import('@/app/api/ynab/import/route')
    const res = await POST(
      new Request('http://x/api/ynab/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountMap }),
      }),
    )
    return { status: res.status, body: await res.json() }
  }

  it('writes 0 rows and reports imported: 0 on a re-run against an unchanged pull, transfer legs staying symmetric', async () => {
    const regular = ynabTx({ id: 'reg-1', account_id: 'acct-1', account_name: 'ENBD', amount: -123_450 })
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', account_name: 'ENBD', amount: -500_000, transfer_transaction_id: 'in' })
    const inLeg = transferLeg({ id: 'in', account_id: 'acct-2', account_name: 'Liv', amount: 500_000, transfer_transaction_id: 'out' })
    fetchYnabTransactionsMock.mockResolvedValue({
      transactions: [regular, outLeg, inLeg],
      serverKnowledge: '1168',
      deletedTransactions: [],
    })

    const first = await runImport({ 'acct-1': 1, 'acct-2': 2 })
    expect(first.status).toBe(200)
    expect(first.body.imported).toBe(3) // 1 regular + 2 transfer legs
    expect(first.body.transfersImported).toBe(1)
    expect(ynabStore.transactions.size).toBe(3)

    const rows = [...ynabStore.transactions.values()]
    const side1 = rows.find((r) => r.ynabId === 'out')!
    const side2 = rows.find((r) => r.ynabId === 'in')!
    expect(side1.linkedTransferId).toBe(side2.id)
    expect(side2.linkedTransferId).toBe(side1.id)

    const second = await runImport({ 'acct-1': 1, 'acct-2': 2 })
    expect(second.status).toBe(200)
    expect(second.body.imported).toBe(0)
    expect(second.body.transfersImported).toBe(0)
    expect(ynabStore.transactions.size).toBe(3)

    // Re-running must not have touched the transfer link.
    const rowsAfter = [...ynabStore.transactions.values()]
    expect(rowsAfter.find((r) => r.ynabId === 'out')!.linkedTransferId).toBe(side2.id)
    expect(rowsAfter.find((r) => r.ynabId === 'in')!.linkedTransferId).toBe(side1.id)
  })

  // finding 1, docs/ynab-import-fix-plan.md: the delta cursor must not advance
  // past a pull that had skips, or the skipped rows become unreachable.
  it('does not advance the server-knowledge cursor when a row was skipped for an unmapped account', async () => {
    const mappedRow = ynabTx({ id: 'mapped', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    const unmappedRow = ynabTx({ id: 'unmapped', account_id: 'acct-3', account_name: 'Unmapped', amount: -2_000 })
    fetchYnabTransactionsMock.mockResolvedValue({
      transactions: [mappedRow, unmappedRow],
      serverKnowledge: '9999',
      deletedTransactions: [],
    })

    const res = await runImport({ 'acct-1': 1 })
    expect(res.status).toBe(200)
    expect(res.body.skippedUnmappedAccounts).toEqual(['Unmapped'])
    expect(ynabStore.settings.get('ynabServerKnowledge')).toBeUndefined()
  })

  // ADR-0004: an unresolved changed/deleted report must hold the cursor the
  // same way an unmapped-account skip does, or the report is a one-shot
  // notice that vanishes if missed.
  it('does not advance the cursor while an ADR-0004 changed/deleted report is outstanding', async () => {
    fetchYnabTransactionsMock.mockResolvedValueOnce({
      transactions: [ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })],
      serverKnowledge: 'v1',
      deletedTransactions: [],
    })
    await runImport({ 'acct-1': 1 })
    expect(ynabStore.settings.get('ynabServerKnowledge')).toBe('v1')

    // Second pull re-delivers 'a' with a different amount (edited in YNAB).
    fetchYnabTransactionsMock.mockResolvedValueOnce({
      transactions: [ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -2_000 })],
      serverKnowledge: 'v2',
      deletedTransactions: [],
    })
    const res = await runImport({ 'acct-1': 1 })
    expect(res.body.changedInYnab).toHaveLength(1)
    expect(ynabStore.settings.get('ynabServerKnowledge')).toBe('v1')
  })

  // QA gap: the run-twice test only covers an all-new-then-all-repeat pull.
  // The actual daily-use shape is a pull with both — assert the new row
  // lands exactly once and the known ones are counted as duplicates, not
  // miscounted on top of the plan-time partition.
  it('writes only the new row when a pull mixes new and already-imported transactions', async () => {
    const known1 = ynabTx({ id: 'known-1', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    const known2 = ynabTx({ id: 'known-2', account_id: 'acct-1', account_name: 'ENBD', amount: -2_000 })
    fetchYnabTransactionsMock.mockResolvedValueOnce({
      transactions: [known1, known2],
      serverKnowledge: 'v1',
      deletedTransactions: [],
    })
    await runImport({ 'acct-1': 1 })
    expect(ynabStore.transactions.size).toBe(2)

    const fresh = ynabTx({ id: 'fresh', account_id: 'acct-1', account_name: 'ENBD', amount: -3_000 })
    fetchYnabTransactionsMock.mockResolvedValueOnce({
      transactions: [known1, known2, fresh],
      serverKnowledge: 'v2',
      deletedTransactions: [],
    })
    const res = await runImport({ 'acct-1': 1 })
    expect(res.body.imported).toBe(1)
    expect(res.body.skippedAlreadyImported).toBe(2)
    expect(ynabStore.transactions.size).toBe(3)
    expect([...ynabStore.transactions.values()].map((r) => r.ynabId).sort()).toEqual(['fresh', 'known-1', 'known-2'])
  })

  // QA gap: the route's central safety claim is "if any step throws, the
  // cursor stays where it was and nothing was written" — previously
  // unverified because the test fake's $transaction never rolled back.
  it('rolls back the whole commit and leaves the cursor untouched if a write fails partway through', async () => {
    const regular = ynabTx({ id: 'reg-1', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', account_name: 'ENBD', amount: -500_000, transfer_transaction_id: 'in' })
    const inLeg = transferLeg({ id: 'in', account_id: 'acct-2', account_name: 'Liv', amount: 500_000, transfer_transaction_id: 'out' })
    fetchYnabTransactionsMock.mockResolvedValueOnce({
      transactions: [regular, outLeg, inLeg],
      serverKnowledge: 'v1',
      deletedTransactions: [],
    })

    // Monkey-patch $transaction for this test only: forward to the real fake
    // (so the snapshot/rollback machinery still runs), but make the second
    // `tx.transaction.create` call throw — after the regular row and the
    // first transfer leg are already written, mid-commit.
    type PrismaLike = {
      $transaction: (cb: (tx: { transaction: { create: (...a: unknown[]) => Promise<unknown> } }) => Promise<unknown>) => Promise<unknown>
    }
    const prismaModule = (await import('@/lib/prisma')) as unknown as { prisma: PrismaLike }
    const realTransaction = prismaModule.prisma.$transaction
    let createCalls = 0
    prismaModule.prisma.$transaction = (cb) =>
      realTransaction((tx) => {
        const originalCreate = tx.transaction.create.bind(tx.transaction)
        tx.transaction.create = async (...args: unknown[]) => {
          createCalls++
          if (createCalls === 2) throw new Error('forced failure for rollback test')
          return originalCreate(...args)
        }
        return cb(tx)
      })

    try {
      const { POST } = await import('@/app/api/ynab/import/route')
      const res = await POST(
        new Request('http://x/api/ynab/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountMap: { 'acct-1': 1, 'acct-2': 2 } }),
        }),
      )
      expect(res.status).toBe(500)
      expect(ynabStore.transactions.size).toBe(0)
      expect(ynabStore.settings.get('ynabServerKnowledge')).toBeUndefined()
      expect(ynabStore.importRecords).toHaveLength(0)
    } finally {
      prismaModule.prisma.$transaction = realTransaction
    }
  })
})

describe('planYnabImport — ADR-0004/0005 changed/deleted detection', () => {
  beforeEach(() => {
    resetStore()
    ynabStore.accounts.set(1, { id: 1, currency: 'AED', name: 'ENBD' })
  })

  async function importOnce(tx: YnabTransaction) {
    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [tx], serverKnowledge: 'v1', deletedTransactions: [] })
    const { POST } = await import('@/app/api/ynab/import/route')
    await POST(
      new Request('http://x/api/ynab/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountMap: { 'acct-1': 1 } }),
      }),
    )
  }

  it('reports a harmless re-delivery as a duplicate, not a change', async () => {
    const tx = ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    await importOnce(tx)

    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [tx], serverKnowledge: 'v2', deletedTransactions: [] })
    const plan = await planYnabImport({ 'acct-1': 1 })
    expect(plan.skippedAlreadyImported).toBe(1)
    expect(plan.changedInYnab).toHaveLength(0)
  })

  it('reports an amount edit as changed, not a duplicate, and does not touch the stored row', async () => {
    const tx = ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    await importOnce(tx)
    const storedBefore = ynabStore.transactions.get(1)!.amount

    const edited = ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -5_000 })
    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [edited], serverKnowledge: 'v2', deletedTransactions: [] })
    const plan = await planYnabImport({ 'acct-1': 1 })
    expect(plan.skippedAlreadyImported).toBe(0)
    expect(plan.changedInYnab).toEqual([
      { ynabId: 'a', date: '2026-07-04', description: 'Carrefour', amount: -500, accountName: 'ENBD' },
    ])
    expect(plan.rows).toHaveLength(0)
    expect(ynabStore.transactions.get(1)!.amount).toBe(storedBefore)
  })

  it('reports a tombstone matching an already-imported row as deleted, using stored YDB identity', async () => {
    const tx = ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    await importOnce(tx)

    fetchYnabTransactionsMock.mockResolvedValueOnce({
      transactions: [],
      serverKnowledge: 'v2',
      deletedTransactions: [{ ...tx, deleted: true }],
    })
    const plan = await planYnabImport({ 'acct-1': 1 })
    expect(plan.deletedInYnab).toEqual([
      { ynabId: 'a', date: '2026-07-04', description: 'Carrefour', amount: -100, accountName: 'ENBD' },
    ])
  })

  it('silently ignores a tombstone for a ynabId never imported', async () => {
    fetchYnabTransactionsMock.mockResolvedValueOnce({
      transactions: [],
      serverKnowledge: 'v1',
      deletedTransactions: [ynabTx({ id: 'never-imported' })],
    })
    const plan = await planYnabImport({ 'acct-1': 1 })
    expect(plan.deletedInYnab).toHaveLength(0)
  })

  // ADR-0005: this is the bug QA found in ADR-0004's original live-row
  // comparison — recategorising an imported row locally must never register
  // as a YNAB-side change, since the snapshot (not the live row) is what's
  // compared. Repeated three times to also prove it doesn't get "worse" or
  // eventually flip on some accumulated state.
  it('never reports a local recategorization as changed in YNAB, even across repeated re-imports', async () => {
    const tx = ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    await importOnce(tx)
    const stored = ynabStore.transactions.get(1)!
    stored.category = 'Renamed Locally'
    stored.accountId = 1 // no-op reassignment, just documents accountId is also PATCH-editable

    for (let i = 0; i < 3; i++) {
      fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [tx], serverKnowledge: `v${i + 2}`, deletedTransactions: [] })
      const plan = await planYnabImport({ 'acct-1': 1 })
      expect(plan.changedInYnab).toHaveLength(0)
      expect(plan.skippedAlreadyImported).toBe(1)
    }
    expect(ynabStore.transactions.get(1)!.category).toBe('Renamed Locally')
  })

  // A row imported before the ynabFingerprint column existed (or one whose
  // snapshot predates a fingerprint-version bump) has no usable snapshot —
  // ADR-0005 says treat it as unchanged rather than flag it.
  it('treats a null or version-mismatched stored fingerprint as unchanged, not as a change', async () => {
    const tx = ynabTx({ id: 'a', account_id: 'acct-1', account_name: 'ENBD', amount: -1_000 })
    await importOnce(tx)

    ynabStore.transactions.get(1)!.ynabFingerprint = null
    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [tx], serverKnowledge: 'v2', deletedTransactions: [] })
    const nullPlan = await planYnabImport({ 'acct-1': 1 })
    expect(nullPlan.changedInYnab).toHaveLength(0)
    expect(nullPlan.skippedAlreadyImported).toBe(1)

    ynabStore.transactions.get(1)!.ynabFingerprint = 'v0|["stale-encoding"]'
    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [tx], serverKnowledge: 'v3', deletedTransactions: [] })
    const stalePlan = await planYnabImport({ 'acct-1': 1 })
    expect(stalePlan.changedInYnab).toHaveLength(0)
    expect(stalePlan.skippedAlreadyImported).toBe(1)
  })
})

describe('planYnabImport — orphaned transfer legs (QA finding: half-deleted transfer)', () => {
  beforeEach(() => {
    resetStore()
    ynabStore.accounts.set(1, { id: 1, currency: 'AED', name: 'ENBD' })
    ynabStore.accounts.set(2, { id: 2, currency: 'AED', name: 'Liv' })
  })

  it('reports a half-deleted transfer as orphaned, not as a duplicate, and never re-writes it', async () => {
    const outLeg = transferLeg({ id: 'out', account_id: 'acct-1', account_name: 'ENBD', amount: -500_000, transfer_transaction_id: 'in' })
    const inLeg = transferLeg({ id: 'in', account_id: 'acct-2', account_name: 'Liv', amount: 500_000, transfer_transaction_id: 'out' })
    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [outLeg, inLeg], serverKnowledge: 'v1', deletedTransactions: [] })
    const { POST } = await import('@/app/api/ynab/import/route')
    await POST(
      new Request('http://x/api/ynab/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountMap: { 'acct-1': 1, 'acct-2': 2 } }),
      }),
    )
    expect(ynabStore.transactions.size).toBe(2)

    // Simulate DELETE /api/transactions/[id] on the 'out' leg: only a
    // locally-created counterpart gets cascade-deleted, so deleting an
    // imported leg unlinks and removes just that one row, leaving 'in' as an
    // orphan — exactly what app/api/transactions/[id]/route.ts does today.
    const outRow = [...ynabStore.transactions.values()].find((r) => r.ynabId === 'out')!
    ynabStore.transactions.delete(outRow.id)
    const inRow = [...ynabStore.transactions.values()].find((r) => r.ynabId === 'in')!
    inRow.linkedTransferId = null

    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [outLeg, inLeg], serverKnowledge: 'v2', deletedTransactions: [] })
    const plan = await planYnabImport({ 'acct-1': 1, 'acct-2': 2 })

    expect(plan.orphanedTransferLegs).toEqual([
      { ynabId: 'in', date: '2026-07-04', description: 'Carrefour', amount: 50_000, accountName: 'Liv' },
    ])
    expect(plan.skippedAlreadyImported).toBe(0)
    expect(plan.changedInYnab).toHaveLength(0)
    expect(plan.transfers).toHaveLength(0)

    // And the cursor must hold — an unresolved orphan report is exactly the
    // kind of unresolved-divergence case ADR-0004's cursor rule covers.
    fetchYnabTransactionsMock.mockResolvedValueOnce({ transactions: [outLeg, inLeg], serverKnowledge: 'v2', deletedTransactions: [] })
    const { POST: POST2 } = await import('@/app/api/ynab/import/route')
    const res = await POST2(
      new Request('http://x/api/ynab/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountMap: { 'acct-1': 1, 'acct-2': 2 } }),
      }),
    )
    const body = await res.json()
    expect(body.orphanedTransferLegs).toHaveLength(1)
    expect(ynabStore.settings.get('ynabServerKnowledge')).toBe('v1')
  })
})
