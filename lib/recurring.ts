import { prisma } from '@/lib/prisma'

export type RecurringSeries = {
  description: string
  category: string
  occurrences: number
  avgAmount: number
  lastDate: string
  avgGap: number
  /** Projected next occurrence: lastDate + avgGap days (Phase 7 item 5). */
  nextDate: string
  /** nextDate is strictly before today (start of day, relative to `asOf`). */
  isOverdue: boolean
  /** nextDate falls in the same calendar month/year as `asOf`. */
  isDueThisMonth: boolean
}

type Tx = { id: number; date: Date; amount: number; description: string; category: string }

/**
 * Detect recurring transaction series (grouped by normalized description
 * prefix, cadence 25–40 day average gap, amount consistency within ±10% of
 * the median) and project each series' next expected occurrence date/amount.
 *
 * `asOf` defaults to now; tests pass it explicitly so overdue/due-this-month
 * assertions aren't flaky around midnight or month boundaries.
 */
export function detectRecurring(txs: Tx[], asOf: Date = new Date()): RecurringSeries[] {
  // Group by normalized description prefix (first 20 chars, alphanumeric + space only)
  const groups = new Map<string, Tx[]>()
  for (const t of txs) {
    const key = t.description
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .slice(0, 20)
      .trim()
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }

  const recurring: RecurringSeries[] = []
  for (const [, group] of groups) {
    if (group.length < 3) continue

    const sorted = [...group].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )

    // Check cadence: average gap must be 25–40 days
    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(
        (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / 86_400_000
      )
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length
    if (avgGap < 25 || avgGap > 40) continue

    // Check amount consistency: all within ±10% of median
    const amounts = sorted.map((t) => Math.abs(t.amount)).sort((a, b) => a - b)
    const median = amounts[Math.floor(amounts.length / 2)]
    if (median === 0) continue
    const consistent = amounts.every((a) => Math.abs(a - median) / median < 0.1)
    if (!consistent) continue

    const roundedGap = Math.round(avgGap)
    const lastDate = new Date(sorted[sorted.length - 1].date)
    const nextDate = new Date(lastDate.getTime() + roundedGap * 86_400_000)

    const startOfToday = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate())
    const isOverdue = nextDate < startOfToday
    const isDueThisMonth =
      nextDate.getFullYear() === asOf.getFullYear() && nextDate.getMonth() === asOf.getMonth()

    recurring.push({
      description: sorted[sorted.length - 1].description,
      category: sorted[sorted.length - 1].category,
      occurrences: sorted.length,
      avgAmount: median,
      lastDate: lastDate.toISOString().split('T')[0],
      avgGap: roundedGap,
      nextDate: nextDate.toISOString().split('T')[0],
      isOverdue,
      isDueThisMonth,
    })
  }

  return recurring
}

/**
 * Fetch committed/reconciled debit transactions and run recurring detection.
 * Shared by `/api/recurring` and the dashboard's "Upcoming this month" widget
 * so both stay in sync — the widget calls this directly (server component)
 * instead of round-tripping through the HTTP route, matching how the other
 * dashboard widgets (net worth, budgets) are fed from `app/dashboard/page.tsx`.
 *
 * `accountIds`, when given, scopes detection to those accounts — the
 * dashboard passes the selected-currency account set so the widget's
 * currency label matches the amounts shown (the bare `/api/recurring` route
 * has no currency context, so it omits this and stays account-agnostic,
 * matching its pre-existing behavior).
 */
export async function getRecurringSeries(
  asOf: Date = new Date(),
  accountIds?: number[],
): Promise<RecurringSeries[]> {
  const txs = await prisma.transaction.findMany({
    where: {
      status: { in: ['committed', 'reconciled'] },
      transactionType: 'debit',
      ...(accountIds ? { accountId: { in: accountIds } } : {}),
    },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, amount: true, description: true, category: true },
    take: 2000,
  })
  return detectRecurring(txs, asOf)
}
