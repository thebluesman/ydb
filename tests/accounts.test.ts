import { describe, expect, it } from 'vitest'
import { computeBalance, isAsset, isLiability } from '@/lib/accounts'

describe('isAsset / isLiability', () => {
  it('classifies known asset types', () => {
    for (const t of ['current', 'savings', 'cash']) {
      expect(isAsset(t)).toBe(true)
      expect(isLiability(t)).toBe(false)
    }
  })
  it('classifies known liability types', () => {
    for (const t of ['credit', 'personal_loan', 'auto_loan']) {
      expect(isLiability(t)).toBe(true)
      expect(isAsset(t)).toBe(false)
    }
  })
  it('treats unknown types as neither', () => {
    expect(isAsset('brokerage')).toBe(false)
    expect(isLiability('brokerage')).toBe(false)
  })
})

describe('computeBalance', () => {
  it('asset: opening + sum', () => {
    // $100 open + ($−20 + $+50) = $130
    expect(computeBalance({ accountType: 'current', openingBalance: 10_000 }, -2_000 + 5_000)).toBe(13_000)
  })
  it('liability: opening − sum (flip)', () => {
    // $500 owed at open, then −$100 spend (raises debt) + $50 payment (lowers debt)
    // storedSum = −100 + 50 = −50 ; balance = 500 − (−50) = 550
    expect(computeBalance({ accountType: 'credit', openingBalance: 50_000 }, -10_000 + 5_000)).toBe(55_000)
  })
  it('zero opening, zero sum', () => {
    expect(computeBalance({ accountType: 'savings', openingBalance: 0 }, 0)).toBe(0)
    expect(computeBalance({ accountType: 'credit', openingBalance: 0 }, 0)).toBe(0)
  })
  it('negative sum on liability reduces debt', () => {
    // Paying down a loan: opening $10,000 owed, payment +$200 (on statement)
    // sum = +200 → balance = 10,000 − 200 = 9,800
    expect(computeBalance({ accountType: 'personal_loan', openingBalance: 1_000_000 }, 20_000)).toBe(980_000)
  })
})
