export type RuleInput = {
  id?: number
  pattern: string
  matchType: string        // "contains" | "starts-with" | "ends-with" | "exact" | "regex"
  vendor?: string          // display name to set on the transaction
  category?: string        // category to assign
  direction: string        // "either" | "debit" | "credit"
  transactionType?: string | null  // output override: "credit" | "debit" | "transfer" | null
  minAmount: number | null
  maxAmount: number | null
  priority: number
}

/**
 * Returns true if the rule matches the given description and signed amount.
 * Four gates must all pass: direction, amount range, and pattern type.
 */
export function matchesRule(rule: RuleInput, description: string, amount: number): boolean {
  // Gate 1 — direction
  if (rule.direction === 'debit' && amount >= 0) return false
  if (rule.direction === 'credit' && amount <= 0) return false

  // Gate 2 — amount range (compared against absolute value)
  const abs = Math.abs(amount)
  if (rule.minAmount !== null && abs < rule.minAmount) return false
  if (rule.maxAmount !== null && abs > rule.maxAmount) return false

  // Gate 3 — pattern
  const desc = description.toLowerCase()
  const pat = rule.pattern.toLowerCase()

  switch (rule.matchType) {
    case 'contains':    return desc.includes(pat)
    case 'starts-with': return desc.startsWith(pat)
    case 'ends-with':   return desc.endsWith(pat)
    case 'exact':       return desc === pat
    case 'regex': {
      try { return new RegExp(rule.pattern, 'i').test(description) }
      catch { return false }
    }
    default: return false
  }
}

/**
 * Returns the highest-priority matching rule, or null if none match.
 * Tie-break: lower id wins (stable, deterministic).
 */
export function findMatchingRule<T extends RuleInput & { id: number }>(
  rules: T[],
  description: string,
  amount: number,
): T | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id)
  for (const rule of sorted) {
    if (matchesRule(rule, description, amount)) return rule
  }
  return null
}

/** Escape LIKE wildcards so a literal `%`/`_` in a user pattern is matched
 *  literally (used with `ESCAPE '\'`). */
export function escapeLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Build a parameterized COUNT(*) query that reproduces matchesRule() in SQL for
 * the non-regex match types. Returns null for `regex` rules (the caller must
 * fall back to countMatchingTransactions in JS). Counts committed/reconciled
 * rows, applying the direction + amount gates and matching the pattern against
 * COALESCE(originalDescription, description) — the same target field as the JS
 * matcher. Placeholders are `?` so the result runs under both Prisma
 * $queryRawUnsafe and better-sqlite3.
 */
export function ruleCountQuery(rule: RuleInput): { sql: string; params: unknown[] } | null {
  if (rule.matchType === 'regex') return null

  const params: unknown[] = []
  const where: string[] = [`status IN ('committed','reconciled')`]

  // Gate 1 — direction (debit ⇒ amount < 0, credit ⇒ amount > 0)
  if (rule.direction === 'debit') where.push('amount < 0')
  else if (rule.direction === 'credit') where.push('amount > 0')

  // Gate 2 — amount range on ABS(amount)
  if (rule.minAmount !== null) { where.push('ABS(amount) >= ?'); params.push(rule.minAmount) }
  if (rule.maxAmount !== null) { where.push('ABS(amount) <= ?'); params.push(rule.maxAmount) }

  // Gate 3 — pattern (case-insensitive via LOWER on both sides)
  const target = `LOWER(COALESCE(originalDescription, description))`
  const pat = rule.pattern.toLowerCase()
  switch (rule.matchType) {
    case 'contains':    where.push(`${target} LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(pat)}%`); break
    case 'starts-with': where.push(`${target} LIKE ? ESCAPE '\\'`); params.push(`${escapeLike(pat)}%`); break
    case 'ends-with':   where.push(`${target} LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(pat)}`); break
    case 'exact':       where.push(`${target} = ?`); params.push(pat); break
    default: return null
  }

  return { sql: `SELECT COUNT(*) AS n FROM "Transaction" WHERE ${where.join(' AND ')}`, params }
}

/**
 * Counts how many transactions satisfy matchesRule for the given rule.
 * Matches against originalDescription when available, falling back to description.
 */
export function countMatchingTransactions(
  rule: RuleInput,
  transactions: { description: string; originalDescription?: string | null; amount: number }[],
): number {
  let count = 0
  for (const tx of transactions) {
    if (matchesRule(rule, tx.originalDescription ?? tx.description, tx.amount)) count++
  }
  return count
}
