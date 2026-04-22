// Canonical balance/liability rules for accounts.
//
// The data keeps statement-style signs:
//   Asset accounts  (current, savings, cash):
//     spend is stored as −X, income/inbound transfer as +X.
//     currentBalance = openingBalance + Σ amount  →  positive means cash held.
//
//   Liability accounts  (credit cards, loans):
//     spend on the card is −X (money left the user), payment received on the
//     card is +X (from the card statement's perspective). To turn that into
//     the debt owed we subtract the tx sum:
//     currentBalance = openingBalance − Σ amount  →  positive means debt owed.
//
// Keep these constants and helpers as the single source of truth — anything
// that classifies accounts as "liquid cash" vs "debt" should import from here.

export const ASSET_TYPES = ['current', 'savings', 'cash'] as const
export const LIABILITY_TYPES = ['credit', 'personal_loan', 'auto_loan'] as const

export type AssetType = (typeof ASSET_TYPES)[number]
export type LiabilityType = (typeof LIABILITY_TYPES)[number]

export function isLiability(accountType: string): boolean {
  return (LIABILITY_TYPES as readonly string[]).includes(accountType)
}

export function isAsset(accountType: string): boolean {
  return (ASSET_TYPES as readonly string[]).includes(accountType)
}

export function computeBalance(
  account: { accountType: string; openingBalance: number },
  txSum: number,
): number {
  return isLiability(account.accountType)
    ? account.openingBalance - txSum
    : account.openingBalance + txSum
}
