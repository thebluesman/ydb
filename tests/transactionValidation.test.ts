import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock the prisma module so validateTransactionWrite can call
// prisma.account.findUnique without a real DB.
vi.mock('@/lib/prisma', () => {
  const state = { accounts: new Map<number, { id: number; currency: string }>() }
  // Expose so individual tests can seed data.
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

import { validateTransactionWrite } from '@/lib/transactionValidation'

const accounts = (globalThis as unknown as { __accounts: Map<number, { id: number; currency: string }> }).__accounts

beforeEach(() => {
  accounts.clear()
  accounts.set(1, { id: 1, currency: 'USD' })
  accounts.set(2, { id: 2, currency: 'USD' })
  accounts.set(3, { id: 3, currency: 'EUR' })
})

describe('validateTransactionWrite — sign rules', () => {
  it('rejects a debit with positive amount', async () => {
    expect(
      await validateTransactionWrite({
        transactionType: 'debit', amount: 100, accountId: 1,
      }),
    ).toMatchObject({ field: 'amount' })
  })
  it('rejects a credit with negative amount', async () => {
    expect(
      await validateTransactionWrite({
        transactionType: 'credit', amount: -100, accountId: 1,
      }),
    ).toMatchObject({ field: 'amount' })
  })
  it('accepts a debit with negative amount', async () => {
    expect(
      await validateTransactionWrite({
        transactionType: 'debit', amount: -100, accountId: 1,
      }),
    ).toBeNull()
  })
  it('accepts a credit with positive amount', async () => {
    expect(
      await validateTransactionWrite({
        transactionType: 'credit', amount: 100, accountId: 1,
      }),
    ).toBeNull()
  })
})

describe('validateTransactionWrite — transfer rules', () => {
  it('requires a counterpart unless allowOneSidedTransfer', async () => {
    const row = {
      transactionType: 'transfer', amount: 100, accountId: 1,
      transferCounterpartAccountId: null,
    }
    expect(await validateTransactionWrite(row)).toMatchObject({
      field: 'transferCounterpartAccountId',
    })
    expect(await validateTransactionWrite(row, { allowOneSidedTransfer: true })).toBeNull()
  })
  it('rejects a transfer whose counterpart is the same account', async () => {
    expect(
      await validateTransactionWrite({
        transactionType: 'transfer', amount: 100, accountId: 1,
        transferCounterpartAccountId: 1,
      }),
    ).toMatchObject({ field: 'transferCounterpartAccountId' })
  })
  it('rejects cross-currency transfers', async () => {
    const err = await validateTransactionWrite({
      transactionType: 'transfer', amount: 100, accountId: 1,
      transferCounterpartAccountId: 3,
    })
    expect(err).not.toBeNull()
    expect(err!.field).toBe('transferCounterpartAccountId')
  })
  it('accepts a same-currency two-sided transfer', async () => {
    expect(
      await validateTransactionWrite({
        transactionType: 'transfer', amount: 100, accountId: 1,
        transferCounterpartAccountId: 2,
      }),
    ).toBeNull()
  })
  it('reports when the counterpart account does not exist', async () => {
    expect(
      await validateTransactionWrite({
        transactionType: 'transfer', amount: 100, accountId: 1,
        transferCounterpartAccountId: 99,
      }),
    ).toMatchObject({ field: 'transferCounterpartAccountId' })
  })
})
