// CSV/OFX statement import (IMPROVEMENT_PLAN Phase 7 item 1).
//
// Two paths feed the same output shape (`MappedTransaction[]`), which lines
// up with the fields `ReviewTable`/`UploadFlow` already expect from the
// OCR+LLM path (date/description/amount, major units, sign already resolved):
//   - CSV: the file is generic, so the user maps its headers to our fields
//     via `CsvMapping` (stored per-account in Settings for reuse).
//   - OFX/QFX: the format is self-describing (STMTTRN blocks with DTPOSTED/
//     TRNAMT/NAME), so it's parsed directly with no mapping step.
//
// All money stays in MAJOR units here, matching the rest of the upload flow
// (UploadFlow.handleCommit converts to integer cents at the API boundary via
// lib/money.toCents — see lib/accounts.ts for the sign/type invariant this
// must respect: debit <= 0, credit >= 0).

export type CsvDateFormat = 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'MM-DD-YYYY' | 'DD-MM-YYYY'

export const CSV_DATE_FORMATS: { value: CsvDateFormat; label: string }[] = [
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (2026-07-16)' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (07/16/2026)' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (16/07/2026)' },
  { value: 'MM-DD-YYYY', label: 'MM-DD-YYYY (07-16-2026)' },
  { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY (16-07-2026)' },
]

// Either a single signed amount column, or separate debit/credit columns
// (debit rows are positive in the file and become negative amounts; credit
// rows stay positive).
export type CsvMapping = {
  dateCol: number
  descriptionCol: number
  dateFormat: CsvDateFormat
  amountCol: number | null
  debitCol: number | null
  creditCol: number | null
  hasHeaderRow: boolean
}

export type MappedTransaction = {
  date: string          // ISO yyyy-mm-dd
  description: string
  amount: number         // major units, signed (debit negative, credit positive)
  transactionType: 'debit' | 'credit'
}

export function isMappingComplete(m: Partial<CsvMapping>): m is CsvMapping {
  if (m.dateCol == null || m.descriptionCol == null || !m.dateFormat) return false
  return m.amountCol != null || (m.debitCol != null && m.creditCol != null)
}

/** Minimal RFC 4180 CSV parser: handles quoted fields, embedded commas/
 *  newlines, and "" escaped quotes. Returns rows of raw string cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Normalise line endings so \r\n inside/outside quotes behaves the same.
  const src = text.replace(/\r\n/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += c
      }
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += c
  }
  // Trailing field/row (files without a final newline).
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  // Drop fully-blank trailing rows (common at EOF).
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop()
  return rows
}

/** Parse a date cell according to the chosen format into an ISO yyyy-mm-dd
 *  string. Returns null if it doesn't match. */
export function parseCsvDate(raw: string, format: CsvDateFormat): string | null {
  const s = raw.trim()
  if (!s) return null
  if (format === 'YYYY-MM-DD') {
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
    if (!m) return null
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
  if (!m) return null
  const [, a, b, y] = m
  const isDayFirst = format === 'DD/MM/YYYY' || format === 'DD-MM-YYYY'
  const day = isDayFirst ? a : b
  const month = isDayFirst ? b : a
  const mm = month.padStart(2, '0')
  const dd = day.padStart(2, '0')
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null
  return `${y}-${mm}-${dd}`
}

/** Apply a mapping to parsed CSV rows, producing normalized transactions.
 *  Rows that fail to parse (bad date, no amount) are skipped and counted so
 *  the UI can warn about them. */
export function applyCsvMapping(
  rows: string[][],
  mapping: CsvMapping,
): { transactions: MappedTransaction[]; skipped: number } {
  const dataRows = mapping.hasHeaderRow ? rows.slice(1) : rows
  const transactions: MappedTransaction[] = []
  let skipped = 0

  for (const row of dataRows) {
    if (row.every((c) => c.trim() === '')) continue
    const date = parseCsvDate(row[mapping.dateCol] ?? '', mapping.dateFormat)
    const description = (row[mapping.descriptionCol] ?? '').trim()
    if (!date || !description) { skipped++; continue }

    let amount: number | null = null
    let transactionType: 'debit' | 'credit' = 'debit'
    if (mapping.amountCol != null) {
      const n = parseSignedNumber(row[mapping.amountCol] ?? '')
      if (n == null) { skipped++; continue }
      amount = n
      transactionType = n < 0 ? 'debit' : 'credit'
    } else if (mapping.debitCol != null && mapping.creditCol != null) {
      const debit = parseSignedNumber(row[mapping.debitCol] ?? '')
      const credit = parseSignedNumber(row[mapping.creditCol] ?? '')
      if (debit && debit !== 0) { amount = -Math.abs(debit); transactionType = 'debit' }
      else if (credit && credit !== 0) { amount = Math.abs(credit); transactionType = 'credit' }
      else { skipped++; continue }
    } else {
      skipped++; continue
    }

    transactions.push({ date, description, amount, transactionType })
  }

  return { transactions, skipped }
}

function parseSignedNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,$£€]/g, '')
  if (!cleaned) return null
  // Accounting negatives: (12.34) or trailing CR/DR markers some exports use.
  const parenNeg = /^\((.+)\)$/.test(cleaned)
  const stripped = parenNeg ? cleaned.slice(1, -1) : cleaned
  const n = Number(stripped)
  if (!Number.isFinite(n)) return null
  return parenNeg ? -Math.abs(n) : n
}

// ── OFX / QFX ────────────────────────────────────────────────────────────────
// Real-world OFX files are frequently SGML, not well-formed XML (no closing
// tags on leaf elements), so a regex-based per-STMTTRN extraction is more
// robust than an XML parser here.

export function parseOfx(text: string): MappedTransaction[] {
  const transactions: MappedTransaction[] = []
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? []
  for (const block of blocks) {
    const date = tag(block, 'DTPOSTED')
    const amountRaw = tag(block, 'TRNAMT')
    const name = tag(block, 'NAME') ?? tag(block, 'MEMO') ?? ''
    if (!date || amountRaw == null) continue
    const amount = Number(amountRaw)
    if (!Number.isFinite(amount)) continue
    // OFX dates are YYYYMMDD[HHMMSS][.xxx][tz] — take the first 8 digits.
    const m = date.match(/^(\d{4})(\d{2})(\d{2})/)
    if (!m) continue
    transactions.push({
      date: `${m[1]}-${m[2]}-${m[3]}`,
      description: name.trim() || 'Unknown',
      amount,
      transactionType: amount < 0 ? 'debit' : 'credit',
    })
  }
  return transactions
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))
  return m ? m[1].trim() : null
}

export function looksLikeOfx(filename: string, text: string): boolean {
  if (/\.(ofx|qfx)$/i.test(filename)) return true
  return /<OFX>/i.test(text.slice(0, 500))
}
