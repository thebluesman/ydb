// Shared free-text similarity heuristic — used by duplicate-check
// (check-duplicates/route.ts) and reimbursement-match suggestions
// (reimbursements/suggest/route.ts) so the two don't drift on what "similar
// description" means.
export function descriptionSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase()
  const s2 = b.toLowerCase()
  if (s1 === s2) return 1
  if (s1.includes(s2) || s2.includes(s1)) return 0.9
  // Dice coefficient using bigrams — handles position and ordering correctly
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const bg1 = bigrams(s1)
  const bg2 = bigrams(s2)
  if (bg1.size === 0 && bg2.size === 0) return 1
  let intersection = 0
  for (const bg of bg1) { if (bg2.has(bg)) intersection++ }
  return (2 * intersection) / (bg1.size + bg2.size)
}
