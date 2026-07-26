import { describe, expect, it, vi } from 'vitest'

// Same approach as tests/transactionValidation.test.ts: mock prisma so
// validateTransactionWrite's transfer-currency lookup doesn't need a real DB.
vi.mock('@/lib/prisma', () => {
  const state = { accounts: new Map<number, { id: number; currency: string }>() }
  ;(globalThis as unknown as { __accounts: typeof state.accounts }).__accounts = state.accounts
  return {
    prisma: {
      account: {
        findUnique: async ({ where: { id } }: { where: { id: number } }) =>
          state.accounts.get(id) ?? null,
      },
    },
  }
})

import { milliunitsToCents } from '@/lib/ynab'
import type { YnabTransaction } from '@/lib/ynab'
import {
  UNCATEGORIZED,
  describeYnabTransaction,
  mapYnabTransaction,
  summarisePlan,
  type ImportPlan,
} from '@/lib/ynabImport'
import { validateTransactionWrite } from '@/lib/transactionValidation'

const testAccounts = (globalThis as unknown as { __accounts: Map<number, { id: number; currency: string }> })
  .__accounts
testAccounts.set(1, { id: 1, currency: 'AED' })
testAccounts.set(2, { id: 2, currency: 'AED' })

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
      skippedDeleted: 0,
      skippedUnmappedAccounts: [],
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

  it('passes the skip counts through for the confirm dialog', () => {
    const s = summarisePlan(
      plan({
        skippedAlreadyImported: 4,
        skippedTransfersIncomplete: 3,
        skippedTransfersCrossCurrency: 2,
        skippedDeleted: 1,
        skippedUnmappedAccounts: ['Car Loan'],
      }),
    )
    expect(s.skippedAlreadyImported).toBe(4)
    expect(s.skippedTransfersIncomplete).toBe(3)
    expect(s.skippedTransfersCrossCurrency).toBe(2)
    expect(s.skippedDeleted).toBe(1)
    expect(s.skippedUnmappedAccounts).toEqual(['Car Loan'])
  })
})
