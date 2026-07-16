import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory fake of the slice of Prisma the DELETE handler touches: findUnique
// with the splitLegs/linkedTransfer includes, and a $transaction callback whose
// `tx` supports update/delete/deleteMany against the same store. This is
// enough to exercise the createdVia-aware cascade (FOLLOWUPS §2 / Phase 6.1)
// without a real DB.
type Row = {
  id: number
  linkedTransferId: number | null
  parentTransactionId: number | null
  createdVia: string
}

vi.mock('@/lib/prisma', () => {
  const store = new Map<number, Row>()
  ;(globalThis as unknown as { __rows: typeof store }).__rows = store

  const findUnique = async ({ where: { id } }: { where: { id: number } }) => {
    const row = store.get(id)
    if (!row) return null
    const splitLegs = [...store.values()]
      .filter((r) => r.parentTransactionId === id)
      .map((r) => ({ id: r.id }))
    const linkedTransfer = row.linkedTransferId != null
      ? (() => {
          const counterpart = store.get(row.linkedTransferId!)
          return counterpart ? { id: counterpart.id, createdVia: counterpart.createdVia } : null
        })()
      : null
    return { ...row, splitLegs, linkedTransfer }
  }

  const txClient = {
    transaction: {
      update: async ({ where: { id }, data }: { where: { id: number }; data: Partial<Row> }) => {
        const row = store.get(id)
        if (row) Object.assign(row, data)
      },
      delete: async ({ where: { id } }: { where: { id: number } }) => {
        store.delete(id)
      },
      deleteMany: async ({ where: { parentTransactionId } }: { where: { parentTransactionId: number } }) => {
        for (const [id, row] of store) {
          if (row.parentTransactionId === parentTransactionId) store.delete(id)
        }
      },
    },
  }

  return {
    prisma: {
      transaction: { findUnique },
      $transaction: async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient),
    },
  }
})

import { DELETE } from '@/app/api/transactions/[id]/route'

const rows = (globalThis as unknown as { __rows: Map<number, Row> }).__rows

function seed(...rs: Row[]) {
  rows.clear()
  for (const r of rs) rows.set(r.id, r)
}

function del(id: number) {
  return DELETE(new Request(`http://x/api/transactions/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id: String(id) }),
  })
}

beforeEach(() => rows.clear())

describe('DELETE /api/transactions/[id] — createdVia-aware transfer cascade', () => {
  it('cascade-deletes the counterpart when it was created in-app (manual)', async () => {
    seed(
      { id: 1, linkedTransferId: 2, parentTransactionId: null, createdVia: 'manual' },
      { id: 2, linkedTransferId: 1, parentTransactionId: null, createdVia: 'manual' },
    )
    const res = await del(1)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, deletedCounterpart: true })
    expect(rows.has(1)).toBe(false)
    expect(rows.has(2)).toBe(false)
  })

  it('unlinks (does not delete) an imported counterpart', async () => {
    seed(
      { id: 1, linkedTransferId: 2, parentTransactionId: null, createdVia: 'manual' },
      { id: 2, linkedTransferId: 1, parentTransactionId: null, createdVia: 'import' },
    )
    const res = await del(1)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, deletedCounterpart: false })
    expect(rows.has(1)).toBe(false)
    expect(rows.has(2)).toBe(true)
    expect(rows.get(2)?.linkedTransferId).toBeNull()
  })

  it('reports deletedCounterpart: false for a row with no linked transfer', async () => {
    seed({ id: 1, linkedTransferId: null, parentTransactionId: null, createdVia: 'import' })
    const res = await del(1)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, deletedCounterpart: false })
    expect(rows.has(1)).toBe(false)
  })

  it('still cascades split legs regardless of the transfer-cascade decision', async () => {
    seed(
      { id: 1, linkedTransferId: null, parentTransactionId: null, createdVia: 'manual' },
      { id: 2, linkedTransferId: null, parentTransactionId: 1, createdVia: 'import' },
      { id: 3, linkedTransferId: null, parentTransactionId: 1, createdVia: 'import' },
    )
    await del(1)
    expect(rows.has(1)).toBe(false)
    expect(rows.has(2)).toBe(false)
    expect(rows.has(3)).toBe(false)
  })

  it('returns ok for an id that no longer exists', async () => {
    seed()
    const res = await del(999)
    expect(await res.json()).toEqual({ ok: true })
  })
})
