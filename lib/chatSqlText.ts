/**
 * Shared text handling for the chat SQL scope guards.
 *
 * Every guard on this path (ADR-0008, ADR-0010, ADR-0011, ADR-0016) is a regex
 * scan over SQL the model just produced, run before execution, deciding only
 * whether to run the query — never rewriting it. They all need the same thing
 * first: a view of the statement in which single-quoted string literals cannot
 * be mistaken for structure. A stored category called `'🍽️ Union Square Diner'`
 * is data, and reading it as a compound operator would refuse an ordinary
 * question.
 *
 * This started as a private helper in `lib/chatCompoundSelect.ts`. ADR-0016's
 * two detectors need the same scan — and one of them needs the literal *values*
 * as well, to tell `transactionType IN ('transfer')` from
 * `transactionType IN ('transfer','credit')` — so it moved here rather than
 * being duplicated or exported from a file named for a different guard.
 */

/** A single-quoted literal, located in the ORIGINAL string. */
export type SqlStringLiteral = {
  /** Offset of the opening quote in the original SQL. */
  start: number
  /** Offset one past the closing quote in the original SQL. */
  end: number
  /** The literal's content with SQLite's doubled-quote escapes resolved. */
  value: string
}

export type SqlTextScan = {
  /**
   * The SQL with every literal (quotes included) replaced by spaces.
   *
   * Character-for-character the same length as the input, so an offset into
   * `stripped` is the same offset in the original. The detectors rely on that to
   * pair a structural match with the literals sitting inside it.
   */
  stripped: string
  /**
   * False when the quoting is unbalanced — an odd number of delimiters, i.e.
   * malformed model output. Stripping then swallows the whole tail of the
   * statement and could hide a real keyword behind a stray apostrophe, so
   * callers fall back to scanning the raw text. The safe direction on this path
   * is to over-reject, never to under-detect.
   */
  balanced: boolean
  /**
   * Every CLOSED literal found, in source order. An unterminated trailing
   * literal is not included — there is no end offset to give it — so callers
   * that need literal values must check `balanced` first.
   */
  literals: SqlStringLiteral[]
}

/**
 * Scan a statement for single-quoted string literals.
 *
 * SQLite escapes a quote by doubling it, which this handles by consuming `''`
 * inside a literal rather than ending it.
 */
export function scanStringLiterals(sql: string): SqlTextScan {
  let out = ''
  let inLiteral = false
  let start = -1
  let value = ''
  const literals: SqlStringLiteral[] = []

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (!inLiteral) {
      if (ch === "'") {
        inLiteral = true
        start = i
        value = ''
        out += ' '
      } else {
        out += ch
      }
      continue
    }
    if (ch === "'") {
      // A doubled quote is an escaped quote, not the end of the literal.
      if (sql[i + 1] === "'") {
        out += '  '
        value += "'"
        i++
        continue
      }
      inLiteral = false
      out += ' '
      literals.push({ start, end: i + 1, value })
      continue
    }
    value += ch
    out += ' '
  }

  return { stripped: out, balanced: !inLiteral, literals }
}

/**
 * The text of the statement's WHERE clause, as an offset range into the
 * *stripped* text, or `null` when there is no WHERE.
 *
 * Deliberately shallow: it takes the FIRST `WHERE` and runs to the first
 * following top-level-ish clause keyword (`GROUP`, `HAVING`, `WINDOW`, `ORDER`,
 * `LIMIT`) or the end of the statement, without tracking subquery nesting. That
 * is enough for what ADR-0016's transfer-sum detector asks — "the WHERE clause
 * pins transactionType = 'transfer'" — on the single-fact-table queries this
 * schema produces, and erring towards a wider range only ever makes the
 * detector fire more readily, which is the accepted direction.
 */
export function whereClauseRange(stripped: string): { start: number; end: number } | null {
  const whereMatch = /\bWHERE\b/i.exec(stripped)
  if (!whereMatch) return null
  const start = whereMatch.index + whereMatch[0].length

  const tail = stripped.slice(start)
  const terminator = /\b(GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT)\b/i.exec(tail)
  const end = terminator ? start + terminator.index : stripped.length
  return { start, end }
}
