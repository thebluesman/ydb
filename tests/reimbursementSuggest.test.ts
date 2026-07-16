import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory fake of the two queries GET /api/reimbursements/suggest issues:
// the outstanding-expense findMany and the candidate-credit findMany (+ the
// already-used-settlement findMany). Exercises the matching/scoring logic
// (FOLLOWUPS §1 / Phase 6.3) without a real DB.
type Account = { id: number; name: string; currency: string }
type Tx = {
  id: number
  description: string
  amount: number
  date: string
  category: string
  transactionType: string
  status: string
  parentTransactionId: number | null
  reimbursableFor: string | null
  reimbursementTxId: number | null
  account: Account
}

vi.mock('@/lib/prisma', () => {
  const store = new Map<number, Tx>()
  ;(globalThis as unknown as { __txs: typeof store }).__txs = store

  return {
    prisma: {
      transaction: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          const rows = [...store.values()]
          if ('reimbursementTxId' in where && (where.reimbursementTxId as { not: null })?.not === null) {
            return rows.filter((r) => r.reimbursementTxId != null)
          }
          return rows.filter((r) => {
            if (where.parentTransactionId !== undefined && r.parentTransactionId !== where.parentTransactionId) return false
            if (where.transactionType !== undefined && r.transactionType !== where.transactionType) return false
            if (where.status !== undefined && r.status !== where.status) return false
            if (where.reimbursableFor !== undefined) {
              const cond = where.reimbursableFor as { not: null }
              if (cond?.not === null && r.reimbursableFor == null) return false
            }
            if (where.reimbursementTxId !== undefined) {
              const cond = where.reimbursementTxId as null | { not: null }
              if (cond === null && r.reimbursementTxId != null) return false
            }
            return true
          })
        },
      },
    },
  }
})

import { GET } from '@/app/api/reimbursements/suggest/route'

const txs = (globalThis as unknown as { __txs: Map<number, Tx> }).__txs

const account = (id: number, currency = 'AED'): Account => ({ id, name: `Acct ${id}`, currency })

function seed(...rows: Tx[]) {
  txs.clear()
  for (const r of rows) txs.set(r.id, r)
}

async function suggest() {
  const res = await GET()
  return (await res.json()) as { suggestions: Array<{ expense: { id: number }; settlement: { id: number }; score: number; matchReason: string }> }
}

beforeEach(() => txs.clear())

describe('GET /api/reimbursements/suggest', () => {
  it('matches an unlinked expense to a same-currency, later-dated credit within 1% by category', async () => {
    seed(
      {
        id: 1, description: 'Hospital visit', amount: -10000, date: '2026-01-01',
        category: 'Health', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 2, description: 'Refund from AXA', amount: 10050, date: '2026-01-10',
        category: 'Reimbursement', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(1),
      },
    )
    const { suggestions } = await suggest()
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      expense: { id: 1 },
      settlement: { id: 2 },
      matchReason: 'category',
    })
  })

  it('matches by description similarity when category does not say Reimbursement', async () => {
    seed(
      {
        id: 1, description: 'Dubai Vet Clinic', amount: -5000, date: '2026-01-01',
        category: 'Pets', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Roommate', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 2, description: 'Dubai Vet Clinic refund', amount: 5000, date: '2026-01-05',
        category: 'Transfer', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(1),
      },
    )
    const { suggestions } = await suggest()
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].matchReason).toBe('description')
  })

  it('rejects a candidate outside the ±1% amount tolerance', async () => {
    seed(
      {
        id: 1, description: 'Hospital visit', amount: -10000, date: '2026-01-01',
        category: 'Health', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 2, description: 'Hospital visit', amount: 12000, date: '2026-01-10',
        category: 'Reimbursement', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(1),
      },
    )
    expect((await suggest()).suggestions).toHaveLength(0)
  })

  it('rejects a candidate dated before the expense', async () => {
    seed(
      {
        id: 1, description: 'Hospital visit', amount: -10000, date: '2026-01-10',
        category: 'Health', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 2, description: 'Hospital visit refund', amount: 10000, date: '2026-01-01',
        category: 'Reimbursement', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(1),
      },
    )
    expect((await suggest()).suggestions).toHaveLength(0)
  })

  it('rejects a candidate on a different-currency account', async () => {
    seed(
      {
        id: 1, description: 'Hospital visit', amount: -10000, date: '2026-01-01',
        category: 'Health', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: null,
        account: account(1, 'AED'),
      },
      {
        id: 2, description: 'Hospital visit refund', amount: 10000, date: '2026-01-10',
        category: 'Reimbursement', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(2, 'GBP'),
      },
    )
    expect((await suggest()).suggestions).toHaveLength(0)
  })

  it('does not suggest a credit that is already linked as someone else\'s settlement', async () => {
    seed(
      {
        id: 1, description: 'Hospital visit', amount: -10000, date: '2026-01-01',
        category: 'Health', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 2, description: 'Hospital visit refund', amount: 10000, date: '2026-01-10',
        category: 'Reimbursement', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(1),
      },
      // Some other expense already claims credit #2 as its settlement.
      {
        id: 3, description: 'Other expense', amount: -10000, date: '2025-12-01',
        category: 'Health', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: 2,
        account: account(1),
      },
    )
    expect((await suggest()).suggestions).toHaveLength(0)
  })

  it('does not double-assign the same credit to two expenses — higher score wins', async () => {
    seed(
      {
        id: 1, description: 'Vet Clinic Alpha', amount: -10000, date: '2026-01-01',
        category: 'Pets', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Roommate', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 2, description: 'Vet Clinic Beta', amount: -10000, date: '2026-01-01',
        category: 'Pets', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Roommate', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 3, description: 'Vet Clinic Alpha', amount: 10000, date: '2026-01-10',
        category: 'Transfer', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(1),
      },
    )
    const { suggestions } = await suggest()
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].expense.id).toBe(1)
  })

  it('ignores expenses that are not committed or already linked', async () => {
    seed(
      {
        id: 1, description: 'Hospital visit', amount: -10000, date: '2026-01-01',
        category: 'Health', transactionType: 'debit', status: 'review',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: null,
        account: account(1),
      },
      {
        id: 2, description: 'Already linked expense', amount: -10000, date: '2026-01-01',
        category: 'Health', transactionType: 'debit', status: 'committed',
        parentTransactionId: null, reimbursableFor: 'Insurance', reimbursementTxId: 99,
        account: account(1),
      },
      {
        id: 3, description: 'Hospital visit refund', amount: 10000, date: '2026-01-10',
        category: 'Reimbursement', transactionType: 'credit', status: 'committed',
        parentTransactionId: null, reimbursableFor: null, reimbursementTxId: null,
        account: account(1),
      },
    )
    expect((await suggest()).suggestions).toHaveLength(0)
  })
})
