import type { ToastApi } from '@/app/_components/ui'

type SplitLeg = { amount: number; category: string; description: string }

type DeletableTransaction = {
  id: number
  date: string | Date
  amount: number
  description: string
  transactionType: string
  category: string
  accountId: number
  status: string
  notes: string | null
  transferCounterpartAccountId: number | null
  reimbursableFor: string | null
  reimbursementTxId: number | null
  reimbursedExpense: { id: number } | null
  splitLegs?: SplitLeg[]
  linkedTransferId: number | null
}

/**
 * Deletes a transaction, then offers a 5s "Undo" toast that re-creates it via
 * POST /api/transactions/manual (+ /[id]/split for split legs, +
 * /[id]/reimburse to re-pair a reimbursement link). Recreated rows get new
 * ids — cheaper than soft-delete and good enough for home use. Shared
 * between the desktop table row and the mobile card so both get undo.
 */
export async function deleteWithUndo(
  transaction: DeletableTransaction,
  toast: ToastApi,
  onDelete: (id: number) => void,
  onRestore?: () => void
) {
  const res = await fetch(`/api/transactions/${transaction.id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Server returned ${res.status}`)
  const { deletedCounterpart } = await res.json() as { deletedCounterpart?: boolean }
  onDelete(transaction.id)

  // A linked transfer whose counterpart was an imported row (not created
  // in-app) survives unlinked rather than being cascade-deleted (FOLLOWUPS
  // §2) — say so, since the counterpart is still sitting in the ledger.
  const hadUnlinkedCounterpart = transaction.linkedTransferId != null && !deletedCounterpart

  const restore = {
    date: typeof transaction.date === 'string' ? transaction.date : transaction.date.toISOString(),
    amount: transaction.amount,
    description: transaction.description,
    transactionType: transaction.transactionType,
    category: transaction.category,
    accountId: transaction.accountId,
    notes: transaction.notes ?? undefined,
    status: transaction.status,
    transferCounterpartAccountId: transaction.transferCounterpartAccountId ?? undefined,
    reimbursableFor: transaction.reimbursableFor ?? undefined,
  }
  const splitLegs = transaction.splitLegs

  // Reimbursement pairing lives on a separate FK (reimbursementTxId), not
  // something /manual create can set directly. Remember which side of the
  // pair this row was so Undo can re-link it via the reimburse endpoint
  // after recreating the row.
  const reimbursementLink = transaction.reimbursementTxId
    ? { role: 'expense' as const, counterpartId: transaction.reimbursementTxId }
    : transaction.reimbursedExpense
      ? { role: 'settlement' as const, counterpartId: transaction.reimbursedExpense.id }
      : null

  const toastMessage = hadUnlinkedCounterpart
    ? 'Transaction deleted — its linked transfer was imported, so it was kept (unlinked) instead of deleted'
    : 'Transaction deleted'

  toast.success(toastMessage, {
    duration: 5000,
    action: {
      label: 'Undo',
      onClick: async () => {
        let recreated: { id: number }
        try {
          const recreateRes = await fetch('/api/transactions/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(restore),
          })
          if (!recreateRes.ok) throw new Error(`Server returned ${recreateRes.status}`)
          recreated = await recreateRes.json()
        } catch (e) {
          toast.error(`Could not restore transaction: ${e instanceof Error ? e.message : String(e)}`)
          return
        }

        // Parent row is back at this point — any failure below is a
        // partial-restore, not a total one, and should be reported as such.
        const warnings: string[] = []

        if (splitLegs && splitLegs.length > 0) {
          try {
            const splitRes = await fetch(`/api/transactions/${recreated.id}/split`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                legs: splitLegs.map((l) => ({ amount: l.amount, category: l.category, description: l.description })),
              }),
            })
            if (!splitRes.ok) throw new Error()
          } catch {
            warnings.push("its split legs couldn't be restored — you'll need to re-split it manually")
          }
        }

        if (reimbursementLink) {
          try {
            const expenseId = reimbursementLink.role === 'expense' ? recreated.id : reimbursementLink.counterpartId
            const targetId = reimbursementLink.role === 'expense' ? reimbursementLink.counterpartId : recreated.id
            const relinkRes = await fetch(`/api/transactions/${expenseId}/reimburse`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ targetId }),
            })
            if (!relinkRes.ok) throw new Error()
          } catch {
            warnings.push("its reimbursement link couldn't be restored — you'll need to re-link it manually")
          }
        }

        onRestore?.()
        if (warnings.length > 0) {
          toast.error(`Transaction restored, but ${warnings.join('; and ')}.`)
        } else {
          toast.success('Transaction restored')
        }
      },
    },
  })
}
