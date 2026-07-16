// Monetary values are stored as integer cents in the DB. All conversion
// between cents and major units happens here so display and write paths
// don't drift.

export function toCents(major: number): number {
  if (!Number.isFinite(major)) return 0
  // Round to avoid 0.1 + 0.2 → 29.999... style drift.
  return Math.round(major * 100)
}

export function fromCents(cents: number): number {
  return cents / 100
}

export function formatCents(
  cents: number,
  currency: string,
  options: Intl.NumberFormatOptions = {},
): string {
  return fromCents(cents).toLocaleString('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
    ...options,
  })
}

// The one money-display helper for plain "CUR 1,234.56" rendering (as opposed
// to formatCents' Intl currency style, which prefixes a locale symbol like
// "$" — most of this UI instead prefixes the ISO currency code, e.g.
// "AED 1,234.56"). Handles the sign so call sites stop hand-rolling
// `< 0 ? '−' : '+'` + `.toFixed(2)`: negative amounts get a real minus sign
// (−, not a hyphen, matching the existing visual convention); positive
// amounts get a leading "+" only when `showPlus` is set (call sites that
// colour debit/credit differently usually want it; plain balances usually
// don't).
export function fmtMoney(
  cents: number,
  currency: string,
  { showPlus = false }: { showPlus?: boolean } = {},
): string {
  const amount = fromCents(Math.abs(cents)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const sign = cents < 0 ? '−' : showPlus && cents > 0 ? '+' : ''
  return `${sign}${currency} ${amount}`
}

// Compact form for chart axes/labels: "1.2k" instead of "1,234.56".
export function fmtMoneyShort(cents: number): string {
  const v = fromCents(cents)
  const abs = Math.abs(v)
  return abs >= 1000 ? `${v < 0 ? '−' : ''}${(abs / 1000).toFixed(1)}k` : String(Math.round(v))
}

// Robust input parser — accepts '$1,234.56', '-AED 50.00', '1,000' etc.
// Returns null if the input is empty or can't be read as a number.
export function parseCents(input: string): number | null {
  if (input == null) return null
  const stripped = String(input)
    .replace(/[^\d.\-,()]/g, '')
    .trim()
  if (!stripped) return null
  // Accounting parens → negative
  let negative = false
  let cleaned = stripped
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true
    cleaned = cleaned.slice(1, -1)
  }
  // If comma looks like a thousands separator, drop it; if it's a decimal
  // (European), convert to a period.
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '')
  } else if (cleaned.includes(',')) {
    const parts = cleaned.split(',')
    // '1,00' → decimal; '1,000' → thousands. Heuristic: 1-2 digits after the last comma = decimal.
    if (parts.length === 2 && parts[1].length <= 2) {
      cleaned = parts.join('.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  }
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return toCents(negative ? -n : n)
}
