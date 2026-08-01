/**
 * Money-arithmetic scope guards for the chat SQL path (ADR-0016).
 *
 * PR #32 fixed two live-found wrong-number bugs in `SQL_SYSTEM_PROMPT`, and both
 * fixes were prompt-only. ADR-0016 asks which of the four money guards can move
 * into code, and answers: **only where the guard's applicability is decidable
 * from the generated SQL alone**. Guard absence is generally not a property of
 * the SQL — `reimbursementTxId IS NULL` is required for "what did I spend" and
 * wrong for "what was I reimbursed", and the two produce identical query shapes,
 * so a detector for it would have to infer intent the pipeline has already been
 * shown it cannot infer (ADR-0015). Split-leg and reimbursement therefore stay
 * prompt-only, held consistent by the guard-matrix test over
 * `buildSqlSystemPrompt`'s output.
 *
 * Two shapes ARE decidable, and this file is those two:
 *
 *   1. `signBranchGuardViolation` — the query branches on the sign of `amount`
 *      and carries no `transactionType` predicate at all. A transfer is stored
 *      as two rows, one negative leg and one positive leg, so a bare sign split
 *      counts the outgoing leg as an expense AND the incoming leg as income.
 *      Both figures come back too high by the same amount, and nothing about the
 *      result looks wrong. The prompt's own rule fires unconditionally at that
 *      trigger, which is exactly what makes it checkable here.
 *
 *   2. `transferSumViolation` — a bare `SUM(amount)` over rows pinned to
 *      `transactionType = 'transfer'`. The legs of a transfer are equal and
 *      opposite, so that sum cancels to approximately zero for any ledger,
 *      however much money actually moved. Arithmetically dead regardless of what
 *      the question meant.
 *
 * Both refuse under ADR-0014's `unsupported-shape` rather than `out-of-scope`:
 * the questions behind them ("what did I earn and spend", "how much did I move
 * between accounts") are perfectly ordinary and chat answers both. What failed
 * is the query we generated for them. Same line ADR-0014's addendum draws for
 * `compoundSelectViolation`, which these sit beside on the route.
 *
 * Both over-reject in the same direction as ADR-0011's ban, deliberately
 * (ADR-0016 § Consequences). A sign-branching query that legitimately wants
 * transfers included has to say `transactionType IN (…)` explicitly to pass —
 * the check demands SOME transactionType predicate, not a specific one, so the
 * transfer-volume shape the prompt teaches goes through untouched. If the trade
 * ever bites, the fix is a code-computed path, not a carve-out here.
 *
 * Lives here and is called from `app/api/chat/route.ts`, not from
 * `lib/prisma.ts`: the read-only guard stays input-agnostic and single-purpose,
 * and these are scope checks on generated SQL, not safety checks.
 */

import { scanStringLiterals, whereClauseRange } from './chatSqlText'

// ─────────────────────────────────────────────────────────────────────────────
// Detector 1 — a sign-branching aggregate with no transactionType predicate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A comparison of `amount` against zero — the sign branch.
 *
 * Covers both forms the prompt and the model actually produce: a `WHERE`
 * predicate (`WHERE amount < 0 AND …`) and a conditional aggregate
 * (`SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)`). They are the same
 * textual construct, so one pattern catches both and there is no need to
 * understand where in the statement it sits.
 *
 * `>=`/`<=` are included because `amount >= 0` splits the ledger exactly as
 * `amount > 0` does; the zero row is not what makes the split wrong.
 * `= 0` and `!= 0` are NOT sign branches — they select or exclude the zero rows
 * without separating inflow from outflow — so neither trips this.
 *
 * The optional qualifier prefix handles `t.amount`, `T1.amount` and
 * `"Transaction".amount`. The reversed form (`0 < amount`) is covered too: the
 * model writes it rarely, but it is the same branch, and a detector that a
 * reordering can slip past is not a detector.
 */
const QUALIFIER = String.raw`(?:(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]+"|\[[^\]]+\]|` + '`[^`]+`' + String.raw`)\s*\.\s*)?`
const SIGN_BRANCH_RE = new RegExp(
  String.raw`${QUALIFIER}\bamount\s*(?:>=|<=|>|<)\s*0` + '|' + String.raw`\b0\s*(?:>=|<=|>|<)\s*${QUALIFIER}\bamount\b`,
  'i',
)

/**
 * SOME predicate on `transactionType`, whichever type it names.
 *
 * ADR-0016 is explicit that the check demands a predicate, not a particular one:
 * `!= 'transfer'`, `IN ('credit','debit')` and `= 'transfer'` all satisfy it,
 * which is what lets the transfer-volume few-shot — a sign branch over
 * transfer-pinned rows, entirely correct — pass. Anything narrower would be a
 * judgement about what the question meant, and that is the line ADR-0016 draws.
 *
 * A bare mention is not enough: `GROUP BY transactionType` or
 * `SELECT transactionType` leaves every transfer leg in the aggregate, so it
 * would satisfy a mention-based check while fixing nothing. The comparison
 * operator (or `IN`) is the part that does work. `IS NOT NULL` is likewise not
 * one — it is true of every row, including both transfer legs.
 */
const TRANSACTION_TYPE_PREDICATE_RE = /\btransactionType\s*(?:==?|!=|<>|\bNOT\s+IN\b|\bIN\b)/i

export type SignBranchGuardViolation = {
  /** The sign comparison as it appeared, e.g. `amount < 0` — so the refusal can quote it. */
  branch: string
}

/**
 * The missing-transactionType violation in the generated SQL, or `null`.
 *
 * A regex scan and not a SQL parse, for the same reason as ADR-0008's category
 * check and ADR-0011's compound check: this is a guard on text the model just
 * produced, run before execution, and it only ever decides whether to run the
 * query — it never rewrites it.
 */
export function signBranchGuardViolation(sql: string): SignBranchGuardViolation | null {
  // Literals blanked, so `description LIKE '%amount > 0%'` is not read as a sign
  // branch. On malformed quoting, scan the raw text: over-rejecting is the safe
  // direction, and stripping an unbalanced statement hides its tail.
  const { stripped, balanced } = scanStringLiterals(sql)
  const text = balanced ? stripped : sql

  const branch = SIGN_BRANCH_RE.exec(text)
  if (!branch) return null
  if (TRANSACTION_TYPE_PREDICATE_RE.test(text)) return null

  return { branch: branch[0].replace(/\s+/g, ' ').trim() }
}

/**
 * The refusal text.
 *
 * ADR-0014's standard and ADR-0016's explicit requirement: name the ARITHMETIC
 * problem. Not "your query was rejected" — what the number would have been, why
 * it would have been too high, and what to add. Voice follows
 * `compoundSelectMessage` and `balanceScopeMessage`.
 */
export function signBranchGuardMessage(violation: SignBranchGuardViolation): string {
  return (
    `I couldn't stand behind the arithmetic on that one, so I didn't run it. The query splits ` +
    `transactions by sign (\`${violation.branch}\`) without saying anything about transactionType, and ` +
    `transfers between your own accounts are stored as two rows — one negative leg leaving an account, ` +
    `one positive leg arriving in another. A bare sign split counts the outgoing leg as spending and the ` +
    `incoming leg as income, so both totals come back too high by the full amount you moved, and nothing ` +
    `in the result looks wrong. Ask again and I'll exclude transfers; if you want them counted, say so ` +
    `explicitly and I'll name the types I'm including.`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Detector 2 — a bare SUM(amount) over transfer-pinned rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `SUM(amount)` with nothing but a column inside it, optionally qualified and
 * optionally negated.
 *
 * Bare is the whole point. `SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)` is
 * the CORRECT way to total transfer volume — it counts each pair's single
 * positive leg once — and must not be caught here. So must `SUM(ABS(amount))`,
 * which is the same figure doubled and at least not zero.
 *
 * `SUM(-amount)` is included because it cancels exactly as `SUM(amount)` does:
 * negating every leg of a pair that already sums to zero still sums to zero.
 * Catching only the un-negated spelling would leave the identical dead figure
 * one keystroke away.
 */
const BARE_SUM_AMOUNT_RE = new RegExp(String.raw`\bSUM\s*\(\s*-?\s*${QUALIFIER}amount\s*\)`, 'i')

/**
 * `transactionType =`, positive only — `!=` and `<>` don't match, since `\s*`
 * won't cross `!` or `<`. `==` is SQLite's other spelling of the same operator.
 *
 * Deliberately stops AT the operator and does not consume the whitespace after
 * it: in the stripped text a literal is a run of spaces, so a trailing `\s*`
 * would swallow the literal itself and lose the offset the value is looked up by.
 */
const TYPE_EQUALS_RE = /\btransactionType\s*==?/gi

/** `transactionType IN (` — with `NOT IN` captured so it can be rejected. */
const TYPE_IN_RE = /\btransactionType\s+(NOT\s+)?IN\s*\(/gi

export type TransferSumViolation = {
  /** How the rows were pinned, e.g. `transactionType = 'transfer'` — quoted back in the refusal. */
  pin: string
}

/**
 * The naive-transfer-sum violation in the generated SQL, or `null`.
 *
 * "Pinned" means the WHERE clause restricts rows to transfers and nothing else:
 * `transactionType = 'transfer'`, or an `IN` list whose every member is
 * `'transfer'`. `IN ('transfer','credit')` is not a pin — the sum no longer
 * cancels by construction, because the credit rows have no matching opposite
 * leg — and `!= 'transfer'` is the opposite of one.
 */
export function transferSumViolation(sql: string): TransferSumViolation | null {
  const { stripped, balanced, literals } = scanStringLiterals(sql)

  if (!balanced) {
    // Malformed quoting: literal offsets are unreliable, so fall back to a
    // direct scan of the raw text. This is the over-rejecting direction only in
    // the sense that it reads the statement as written.
    if (!BARE_SUM_AMOUNT_RE.test(sql)) return null
    const raw = /\btransactionType\s*=\s*'transfer'/i.exec(sql)
    return raw ? { pin: raw[0].replace(/\s+/g, ' ') } : null
  }

  if (!BARE_SUM_AMOUNT_RE.test(stripped)) return null

  const where = whereClauseRange(stripped)
  if (!where) return null

  /** The literals sitting inside a span of the statement, by offset. */
  const literalsIn = (start: number, end: number) =>
    literals.filter((lit) => lit.start >= start && lit.end <= end)

  /** The literal immediately following `offset`, with only whitespace between. */
  const literalAfter = (offset: number) =>
    literals.find((lit) => lit.start >= offset && stripped.slice(offset, lit.start).trim() === '')

  // `transactionType = 'transfer'`
  TYPE_EQUALS_RE.lastIndex = 0
  for (let m = TYPE_EQUALS_RE.exec(stripped); m; m = TYPE_EQUALS_RE.exec(stripped)) {
    if (m.index < where.start || m.index >= where.end) continue
    const literal = literalAfter(m.index + m[0].length)
    if (literal && literal.value === 'transfer') {
      return { pin: `transactionType = 'transfer'` }
    }
  }

  // `transactionType IN ('transfer')` — a pin only if every member is 'transfer'.
  TYPE_IN_RE.lastIndex = 0
  for (let m = TYPE_IN_RE.exec(stripped); m; m = TYPE_IN_RE.exec(stripped)) {
    if (m.index < where.start || m.index >= where.end) continue
    if (m[1]) continue // NOT IN is the opposite of a pin
    const open = m.index + m[0].length - 1
    const close = stripped.indexOf(')', open)
    if (close === -1) continue
    const members = literalsIn(open, close)
    if (members.length > 0 && members.every((lit) => lit.value === 'transfer')) {
      return { pin: `transactionType IN ('transfer')` }
    }
  }

  return null
}

/**
 * The refusal text.
 *
 * Same standard as `signBranchGuardMessage`: name the arithmetic. This one has
 * an unusually good answer to "what would have happened" — a confident zero —
 * and saying so is the difference between a refusal the user can act on and one
 * that reads as a crash.
 */
export function transferSumMessage(violation: TransferSumViolation): string {
  return (
    `I couldn't stand behind the arithmetic on that one, so I didn't run it. The query totals ` +
    `SUM(amount) over rows pinned to ${violation.pin}, and every transfer is stored as a matched pair ` +
    `of equal and opposite legs — money leaving one of your accounts and the same money arriving in ` +
    `another. That sum cancels to zero for any ledger, however much you actually moved, so the answer ` +
    `would have been a confident "nothing" that says nothing about your money. Ask how much you moved ` +
    `between accounts and I'll total the incoming legs instead, which counts each transfer exactly once.`
  )
}
