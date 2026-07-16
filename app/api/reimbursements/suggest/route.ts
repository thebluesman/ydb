import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { descriptionSimilarity } from '@/lib/textSimilarity'

// Suggests candidate credit transactions to settle each outstanding
// reimbursable expense (FOLLOWUPS §1 — bulk reimbursement linking). One best
// candidate per expense, so the UI can offer a flat confirm/dismiss list
// without a picker.
const AMOUNT_TOLERANCE_PCT = 0.01
const SIMILARITY_THRESHOLD = 0.4

export async function GET() {
  const expenses = await prisma.transaction.findMany({
    where: {
      parentTransactionId: null,
      reimbursableFor: { not: null },
      reimbursementTxId: null,
      status: 'committed',
      transactionType: 'debit',
    },
    select: {
      id: true,
      description: true,
      amount: true,
      date: true,
      reimbursableFor: true,
      account: { select: { id: true, name: true, currency: true } },
    },
  })

  if (expenses.length === 0) {
    return NextResponse.json({ suggestions: [] })
  }

  // Candidate pool: committed credits not already spoken for as someone
  // else's settlement (reimbursementTxId is @unique, so a credit can settle
  // at most one expense).
  const [credits, alreadyUsed] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        parentTransactionId: null,
        transactionType: 'credit',
        status: 'committed',
      },
      select: {
        id: true,
        description: true,
        amount: true,
        date: true,
        category: true,
        account: { select: { id: true, name: true, currency: true } },
      },
    }),
    prisma.transaction.findMany({
      where: { reimbursementTxId: { not: null } },
      select: { reimbursementTxId: true },
    }),
  ])
  const usedCreditIds = new Set(alreadyUsed.map((r) => r.reimbursementTxId))
  const availableCredits = credits.filter((c) => !usedCreditIds.has(c.id))

  // Score every (expense, credit) pair, then greedily assign highest-score
  // pairs first so the same credit isn't suggested for two different
  // expenses. Good enough for a home-user's few dozen outstanding rows —
  // not a real assignment-problem solver.
  type Pair = {
    expense: (typeof expenses)[number]
    credit: (typeof availableCredits)[number]
    score: number
    matchReason: 'category' | 'description'
  }
  const pairs: Pair[] = []
  for (const expense of expenses) {
    const expenseAbs = Math.abs(expense.amount)
    const tolerance = Math.round(expenseAbs * AMOUNT_TOLERANCE_PCT)
    const expenseTime = new Date(expense.date).getTime()

    for (const credit of availableCredits) {
      if (credit.account.currency !== expense.account.currency) continue
      if (new Date(credit.date).getTime() <= expenseTime) continue
      if (Math.abs(credit.amount - expenseAbs) > tolerance) continue

      const categoryMatch = credit.category === 'Reimbursement'
      const sim = descriptionSimilarity(expense.description, credit.description)
      if (!categoryMatch && sim < SIMILARITY_THRESHOLD) continue

      const score = categoryMatch ? Math.max(sim, 0.95) : sim
      pairs.push({ expense, credit, score, matchReason: categoryMatch ? 'category' : 'description' })
    }
  }
  pairs.sort((a, b) => b.score - a.score)

  const claimedExpenseIds = new Set<number>()
  const claimedCreditIds = new Set<number>()
  const suggestions = []
  for (const { expense, credit, score, matchReason } of pairs) {
    if (claimedExpenseIds.has(expense.id) || claimedCreditIds.has(credit.id)) continue
    claimedExpenseIds.add(expense.id)
    claimedCreditIds.add(credit.id)
    suggestions.push({
      expense: {
        id: expense.id,
        description: expense.description,
        amount: expense.amount,
        date: expense.date,
        reimbursableFor: expense.reimbursableFor,
        account: { id: expense.account.id, name: expense.account.name },
      },
      settlement: {
        id: credit.id,
        description: credit.description,
        amount: credit.amount,
        date: credit.date,
        account: { id: credit.account.id, name: credit.account.name },
      },
      score,
      matchReason,
    })
  }

  return NextResponse.json({ suggestions })
}
