import { prisma } from '@/lib/prisma'

// Write-side rules (see lib/accounts.ts for the balance convention):
//   debit    → amount must be ≤ 0  (stored as money leaving the account)
//   credit   → amount must be ≥ 0  (money entering the account)
//   transfer → sign is free (direction is encoded in the sign), but the
//              counterpart account must exist, differ from the source
//              account, and share its currency. "Unset counterpart" is
//              allowed only for bulk imports, which are one-sided by
//              nature (each statement is one side).
//
// Validation flags inconsistent writes at the boundary so garbage can't
// slip into the ledger and silently skew the dashboard months later.

export type TxForValidation = {
  transactionType: string
  amount: number
  accountId: number
  transferCounterpartAccountId?: number | null
}

export type ValidationError = { error: string; field?: string }

export async function validateTransactionWrite(
  t: TxForValidation,
  opts: {
    allowOneSidedTransfer?: boolean
    /** Pre-fetched `accountId -> currency`, so a caller that already looked
     *  these up (e.g. planYnabImport's per-transfer cross-currency check)
     *  doesn't pay for a second DB round-trip per leg. Falls back to a DB
     *  lookup for any account not present in the map. */
    accountCurrencies?: Map<number, string>
  } = {},
): Promise<ValidationError | null> {
  if (t.transactionType === 'debit' && t.amount > 0) {
    return { error: 'debit amount must be zero or negative', field: 'amount' }
  }
  if (t.transactionType === 'credit' && t.amount < 0) {
    return { error: 'credit amount must be zero or positive', field: 'amount' }
  }

  if (t.transactionType === 'transfer') {
    if (t.transferCounterpartAccountId == null) {
      if (!opts.allowOneSidedTransfer) {
        return {
          error: 'transfer requires a counterpart account',
          field: 'transferCounterpartAccountId',
        }
      }
      return null
    }
    if (t.transferCounterpartAccountId === t.accountId) {
      return {
        error: 'transfer counterpart cannot be the same account as the source',
        field: 'transferCounterpartAccountId',
      }
    }
    const cached = opts.accountCurrencies
    const currencyOf = (id: number) =>
      cached?.has(id)
        ? Promise.resolve(cached.get(id))
        : prisma.account.findUnique({ where: { id }, select: { currency: true } }).then((a) => a?.currency)
    // Parallel, same as before opts.accountCurrencies was added — a cache
    // miss on both sides must not regress a manual/bulk transfer write back
    // to two sequential round-trips.
    const [srcCurrency, dstCurrency] = await Promise.all([
      currencyOf(t.accountId),
      currencyOf(t.transferCounterpartAccountId),
    ])
    if (!srcCurrency) return { error: 'source account not found', field: 'accountId' }
    if (!dstCurrency) {
      return {
        error: 'transfer counterpart account not found',
        field: 'transferCounterpartAccountId',
      }
    }
    if (srcCurrency !== dstCurrency) {
      return {
        error: `cross-currency transfers not supported (${srcCurrency} → ${dstCurrency})`,
        field: 'transferCounterpartAccountId',
      }
    }
  }

  return null
}
