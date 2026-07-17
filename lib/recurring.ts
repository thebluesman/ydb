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
 * How many of the most recent occurrences to keep *per description group* when
 * fetching candidates in `getRecurringSeries`. Roughly a year of a monthly
 * series — plenty to establish cadence/amount consistency while reflecting
 * current (not years-old) pricing, and small enough that the total row count is
 * bounded by (distinct descriptions × this) instead of by raw history depth.
 */
const RECURRING_PER_GROUP_LIMIT = 12

/**
 * A detected series is only "live" — worth projecting a next occurrence for —
 * if its most recent occurrence is within this many cadence periods of `asOf`.
 * Cadence here is always ~monthly (see the 25–40 day gate below), so this is
 * roughly a 3-month grace window: a bill that's missed one or two payments is
 * still surfaced (and flagged overdue), but one that stopped years ago (e.g. a
 * cancelled subscription) is dropped instead of being projected forward forever
 * and shown as permanently "overdue" on the dashboard's Upcoming Bills widget.
 *
 * This staleness cut used to happen only as a side effect of the old global row
 * cap, which truncated years-old history out of the detection window entirely.
 * Per-group windowing (see `takeRecentPerGroup`) keeps each series' own recent
 * history regardless of unrelated volume, so a long-dead series is now detected
 * again — the liveness cut is therefore made deliberately in `getRecurringSeries`.
 */
const MAX_STALE_CYCLES = 3

/**
 * Normalized grouping key for a transaction description: lowercased, stripped to
 * alphanumeric + space, first 20 chars. Shared by `detectRecurring` (which
 * groups candidate occurrences) and `takeRecentPerGroup` (the fetch window in
 * `getRecurringSeries`) so both bucket transactions identically — if the two
 * drifted, the per-group cap could evict occurrences that detection then wants.
 */
function groupKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .slice(0, 20)
    .trim()
}

/**
 * Keep only the most recent `perGroupLimit` transactions per normalized
 * description group. Input must be newest-first; output preserves that order.
 *
 * This replaces `getRecurringSeries`'s old *global* row cap. A single flat cap
 * (`take: 2000`, newest-first) is fetched across all groups at once, so on a
 * dense dataset a high-volume vendor/account can consume the whole window and
 * push a genuine low-volume series (e.g. a monthly subscription among thousands
 * of card purchases) entirely out of it — the series is then never detected.
 * Capping per group instead bounds total work by (distinct descriptions ×
 * `perGroupLimit`) while guaranteeing every group keeps its own most-recent
 * history, so no series is starved by unrelated transaction volume elsewhere.
 */
export function takeRecentPerGroup<T extends { description: string }>(
  txsNewestFirst: T[],
  perGroupLimit = RECURRING_PER_GROUP_LIMIT,
): T[] {
  const counts = new Map<string, number>()
  const kept: T[] = []
  for (const t of txsNewestFirst) {
    const key = groupKey(t.description)
    if (!key) continue
    const n = counts.get(key) ?? 0
    if (n >= perGroupLimit) continue
    counts.set(key, n + 1)
    kept.push(t)
  }
  return kept
}

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
    const key = groupKey(t.description)
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
  perGroupLimit = RECURRING_PER_GROUP_LIMIT,
): Promise<RecurringSeries[]> {
  // Fetch newest-first. detectRecurring's gap math assumes chronological order,
  // so we re-sort ascending after windowing.
  //
  // The window is applied *per description group* (`takeRecentPerGroup`), not as
  // one global row cap. The old flat `take: 2000` (added on PR #18 to stop the
  // detector reading a years-stale oldest-first slice) fixed staleness but was
  // still global: on a dense dataset the newest 2000 rows can all belong to a
  // few high-volume vendors, pushing a genuine low-volume monthly series out of
  // the window so it's never detected (reproduced on a ~49k-row seed where the
  // 2000-row window spanned only ~6 weeks). Per-group capping keeps each group's
  // own recent history regardless of unrelated volume, so no series is starved.
  const txs = await prisma.transaction.findMany({
    where: {
      status: { in: ['committed', 'reconciled'] },
      transactionType: 'debit',
      ...(accountIds ? { accountId: { in: accountIds } } : {}),
    },
    orderBy: { date: 'desc' },
    select: { id: true, date: true, amount: true, description: true, category: true },
  })
  const windowed = takeRecentPerGroup(txs, perGroupLimit)
  windowed.reverse()

  const series = detectRecurring(windowed, asOf)

  // Drop series whose most recent occurrence is more than MAX_STALE_CYCLES
  // cadence periods before `asOf` — a long-cancelled subscription would
  // otherwise be projected forward forever and shown as permanently "overdue".
  // The old global cap masked these by truncating dead history out of the
  // window; per-group windowing no longer does, so cut them explicitly here.
  const startOfToday = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate())
  return series.filter((s) => {
    const last = new Date(`${s.lastDate}T00:00:00Z`)
    const cyclesStale = (startOfToday.getTime() - last.getTime()) / 86_400_000 / s.avgGap
    return cyclesStale <= MAX_STALE_CYCLES
  })
}
