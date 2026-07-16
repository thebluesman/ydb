// The one date-display helper for table/list rows across the app ("14 Jul
// 2026"). Distinct from the YYYY-MM-DD helpers used to seed date-input/
// DatePicker values — those stay local to their components since they feed a
// controlled input, not a read-only cell.
export function formatDate(input: string | Date | null | undefined): string {
  if (input == null || input === '') return '—'
  const d = typeof input === 'string' ? new Date(input) : input
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
