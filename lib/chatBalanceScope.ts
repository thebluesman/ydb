/**
 * Balance-semantics scope guard for the chat SQL path (ADR-0010).
 *
 * Scope, unchanged from ADR-0009: balance, net worth and amount-outstanding are
 * not answerable by chat-generated SQL. What changed is the enforcement.
 *
 * ADR-0009 rejected SQL that named `Account.openingBalance`. Reading the stored
 * `ChatMessage.sql` back showed that check has a 100% miss rate on the only real
 * balance bug in the log. Session 10 ("which should I pay off first") generated
 *
 *   SELECT Account.name, SUM("Transaction".amount) / 100.0 AS total_balance
 *   ... WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('now'))
 *
 * on a liability account, and narration reported "a car loan with a total
 * balance of AED 2344.68". That is one month's net flow served as the debt owed.
 * The query never touches `openingBalance`, joins no balance arithmetic, and
 * would have sailed past ADR-0009's guard. `SUM(amount)` over any period is net
 * flow; it is never a balance.
 *
 * So the check moves to the output label. Narration receives `JSON.stringify(rows)`
 * and nothing else — no schema, no SQL, no account types. The column name is the
 * only thing telling it what a number means, and the model writes that name at
 * inference time. `total_balance` is not a description of the query, it is an
 * unverified claim about it, and in session 10 the claim was false. Rejecting
 * the claim is cheaper and more honest than checking the arithmetic behind it.
 *
 * Two rejections, both applied to both SQL-generation passes:
 *
 *   1. SQL naming `openingBalance` — carried over from ADR-0009. Zero on every
 *      account today (ADR-0003), but that is an accident of the migration and
 *      correctness should never have rested on it. Costs one line.
 *   2. SQL whose result-column aliases assert balance semantics: `balance`,
 *      `net_worth`, `outstanding`, `owed`.
 *
 * Known, accepted gap: a real balance aliased plain `total` slips through. That
 * is bounded by the fact that narration has to name the figure to mislead, and
 * it is strictly better than a check with a demonstrated 100% miss rate. Per
 * ADR-0010, do NOT grow this into general query analysis — needing exceptions is
 * the signal to build the `computeBalance`-backed path instead.
 *
 * Over-rejection is wider than ADR-0009's and deliberately so: "balance" is an
 * ordinary word, so a legitimate per-account flow question the model happens to
 * alias `balance` gets declined too. Same safe direction, higher rate.
 *
 * This lives here and is called from `app/api/chat/route.ts`, not from
 * `lib/prisma.ts`: the read-only guard stays input-agnostic and single-purpose,
 * and this is a scope check on generated SQL, not a safety check.
 *
 * ── The star-expansion gap (added 2026-08-01) ────────────────────────────────
 *
 * `SELECT * FROM Account WHERE accountType = 'auto_loan'` names no column at
 * all, so both SQL-text checks above pass it, and `openingBalance` arrives in
 * the result rows anyway — via the star expansion — where narration is free to
 * read it as a live balance. That is the ADR-0009 miss all over again: a check
 * aimed at a construct the model does not have to use.
 *
 * The fix follows ADR-0010's own logic rather than extending the text scan.
 * ADR-0010 moved enforcement from the input column to the OUTPUT LABEL, because
 * narration receives `JSON.stringify(rows)` and the key is the only thing
 * telling it what a number means. Result-row keys ARE those output labels — the
 * same labels, resolved by SQLite instead of written out by the model. So the
 * check is applied to them, after execution and before narration, by
 * `balanceScopeRowViolation` below.
 *
 * The alternative considered and rejected: banning `SELECT *` outright in the
 * SQL text. Cheaper, and it never spends a query — but it puts enforcement back
 * on the input, which is the direction ADR-0010 abandoned for cause, and it
 * over-rejects into ordinary territory ("show me my recent transactions" is a
 * perfectly good star projection over a table with no sensitive column). Rows
 * cost nothing to inspect: the query has already run on a read-only connection,
 * which is the actual safety boundary, and refusing after execution costs one
 * local SQLite read and no model tokens — narration is where the tokens are, and
 * narration is what this stops.
 *
 * Note the direction of the win: this is a check on what the *engine* produced,
 * so it is exact rather than heuristic. It is not general query analysis (the
 * thing ADR-0010 forbids growing this into) — it never looks at the query.
 */

/**
 * Alias vocabulary that asserts balance semantics, per ADR-0010 § Decision.
 *
 * Each entry is matched as a whole word-token sequence against the alias, not as
 * a raw substring — `net_worth` has to appear as the tokens `net` then `worth`,
 * so `networking` and `rebalanced` don't trip it while `total_balance`,
 * `netWorth` and `amount_outstanding` do.
 *
 * Fixed at four. Adding a fifth is a signal to reread ADR-0010 § Consequences.
 */
export const BALANCE_ALIAS_WORDS = ['balance', 'net_worth', 'outstanding', 'owed'] as const

/** The column ADR-0009 banned and ADR-0010 keeps banned. */
const OPENING_BALANCE_RE = /opening_?balance/i

/**
 * Result-column aliases. Handles the quoting styles SQLite accepts
 * (`"x"`, `'x'`, `` `x` ``, `[x]`) as well as a bare identifier.
 *
 * Deliberately a regex scan and not a SQL parse, for the same reason as
 * ADR-0008's category check: this is a guard on text the model just produced,
 * run before execution, and it only ever decides whether to run the query — it
 * never rewrites it.
 */
const ALIAS_RE = /\bAS\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/gi

/** Alias split into lowercase word tokens: `total_balanceDue` → ['total','balance','due']. */
function aliasTokens(alias: string): string[] {
  return alias
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** A token matches a vocabulary word exactly, or as its plural. */
function tokenMatches(token: string, word: string): boolean {
  return token === word || token === `${word}s`
}

/** Whether the alias contains the word (or multi-word phrase) as contiguous tokens. */
function aliasAsserts(alias: string, word: string): boolean {
  const wanted = word.split('_')
  const tokens = aliasTokens(alias)
  for (let i = 0; i + wanted.length <= tokens.length; i++) {
    if (wanted.every((w, j) => tokenMatches(tokens[i + j], w))) return true
  }
  return false
}

/** Every result-column alias in a generated statement, in source order. */
export function extractAliases(sql: string): string[] {
  const found: string[] = []
  for (const m of sql.matchAll(ALIAS_RE)) {
    const alias = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]
    if (alias) found.push(alias)
  }
  return found
}

export type BalanceScopeViolation =
  /** The query names `Account.openingBalance` (ADR-0009, carried over). */
  | { kind: 'opening-balance' }
  /** A result-column alias claims balance semantics the query can't support. */
  | { kind: 'balance-alias'; alias: string; word: string }

/**
 * The first balance-scope violation in the generated SQL, or `null` if it is in
 * scope.
 *
 * `openingBalance` is checked first so `SELECT openingBalance AS balance` is
 * reported as what it actually is.
 */
export function balanceScopeViolation(sql: string): BalanceScopeViolation | null {
  if (OPENING_BALANCE_RE.test(sql)) return { kind: 'opening-balance' }

  for (const alias of extractAliases(sql)) {
    for (const word of BALANCE_ALIAS_WORDS) {
      if (aliasAsserts(alias, word)) return { kind: 'balance-alias', alias, word }
    }
  }
  return null
}

// ── Result-row keys (the star-expansion net) ────────────────────────────────

export type BalanceScopeRowViolation =
  /** A result column IS `openingBalance`, however it got there. */
  | { kind: 'result-opening-balance'; column: string }
  /** A result column's name asserts balance semantics, per BALANCE_ALIAS_WORDS. */
  | { kind: 'result-balance-alias'; column: string; word: string }

/**
 * The union of every key present across the result rows, in first-seen order.
 *
 * All rows rather than `rows[0]`: better-sqlite3 gives uniform keys today, but
 * that is a property of the driver and not of this check, and a first row that
 * happened to be sparse would be a silent hole in a guard whose whole job is
 * to have no silent holes. The cost is a walk over at most the driver's row cap.
 */
function resultColumns(rows: unknown[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    for (const key of Object.keys(row as Record<string, unknown>)) seen.add(key)
  }
  return [...seen]
}

/**
 * The first balance-scope violation among the columns a query actually
 * returned, or `null` if the result set is in scope.
 *
 * Run AFTER execution and BEFORE narration. It exists for the projections that
 * cannot be judged from the query string — `SELECT *`, `SELECT a.*`, a star in
 * a CTE — where the column list is decided by the schema rather than written by
 * the model. `balanceScopeViolation` above still runs first and still catches
 * everything the text can decide, so a named `openingBalance` never gets as far
 * as being executed.
 *
 * The two rules are the same two rules, deliberately: this is one scope
 * decision with two enforcement points, not a second policy.
 */
export function balanceScopeRowViolation(rows: unknown[]): BalanceScopeRowViolation | null {
  const columns = resultColumns(rows)

  for (const column of columns) {
    if (OPENING_BALANCE_RE.test(column)) return { kind: 'result-opening-balance', column }
  }
  for (const column of columns) {
    for (const word of BALANCE_ALIAS_WORDS) {
      if (aliasAsserts(column, word)) return { kind: 'result-balance-alias', column, word }
    }
  }
  return null
}

/**
 * Why the figure can't be computed here, and where the real one lives. Shared
 * verbatim with `balanceIntentMessage` (ADR-0015): the scope decision is one
 * decision and should read identically whichever net catches it. Only the detail
 * sentence differs between the two — this file names a SQL alias or column,
 * ADR-0015's names the question wording.
 */
export const BALANCE_SCOPE_PARAGRAPH =
  `Account balances, net worth and amounts outstanding are out of scope for chat: they can't be ` +
  `computed in SQL here. A balance is an account's opening balance combined with every transaction ` +
  `over its whole life, with the sign rule for its account type — not something a filtered query ` +
  `adds up. The dashboard and the accounts page show the real figures.`

/** What chat *can* answer instead. Shared with `balanceIntentMessage` for the same reason. */
export const BALANCE_SCOPE_ALTERNATIVE =
  `I can still answer this from transactions: spend or income over a period, by category, by account, ` +
  `or per month. Ask for the flow and read the balance off the dashboard.`

/**
 * The refusal text.
 *
 * ADR-0014's standard: say what was declined, why the number would have been
 * wrong, and where the real figure lives. "Your query was rejected" is not an
 * answer; "I can't compute balances — the dashboard has them" is.
 */
export function balanceScopeMessage(violation: BalanceScopeViolation): string {
  const detail =
    violation.kind === 'opening-balance'
      ? `The query reached for Account.openingBalance, so I didn't run it.`
      : `The query labelled a result column "${violation.alias}", which claims to be a balance figure. ` +
        `What it would actually have returned is the net flow across the filtered period — inflow minus ` +
        `outflow for those dates — and narrating that as a balance is exactly the wrong-number failure ` +
        `this check exists to stop. So I didn't run it.`

  return `${detail} ${BALANCE_SCOPE_PARAGRAPH} ${BALANCE_SCOPE_ALTERNATIVE}`
}

/**
 * The refusal text for a violation found in the result rows.
 *
 * Says explicitly that the query ran, because it did — the user can see the SQL
 * on the frame and "I didn't run it" would be a lie about work that happened.
 * Nothing was narrated, which is the part that matters.
 */
export function balanceScopeRowMessage(violation: BalanceScopeRowViolation): string {
  const detail =
    violation.kind === 'result-opening-balance'
      ? `The query ran, but it came back with an Account.openingBalance column ("${violation.column}") — ` +
        `a SELECT * picks that up without ever naming it — so I stopped before describing the result. ` +
        `An opening balance is not a current balance, and reporting it as one is the wrong-number ` +
        `failure this check exists to stop.`
      : `The query ran, but one of the columns it returned is named "${violation.column}", which claims ` +
        `to be a balance figure. I stopped before describing the result rather than repeat that claim.`

  return `${detail} ${BALANCE_SCOPE_PARAGRAPH} ${BALANCE_SCOPE_ALTERNATIVE}`
}
