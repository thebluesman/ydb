export type RuleInput = {
  id?: number
  pattern: string
  matchType: string   // "contains" | "starts-with" | "ends-with" | "exact" | "regex"
  direction: string   // "either" | "debit" | "credit"
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

/**
 * Counts how many transactions satisfy matchesRule for the given rule.
 */
export function countMatchingTransactions(
  rule: RuleInput,
  transactions: { description: string; amount: number }[],
): number {
  let count = 0
  for (const tx of transactions) {
    if (matchesRule(rule, tx.description, tx.amount)) count++
  }
  return count
}
