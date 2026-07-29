/**
 * The SQL-generation system prompt for the chat path.
 *
 * Lives here rather than inline in `app/api/chat/route.ts` because it is no
 * longer a constant: it has to be rebuilt per request so the model is told
 * what today's actual date is. Being a plain function of `now` also makes the
 * date rules testable without standing up Ollama.
 *
 * Why the date has to be injected at all: genuinely relative phrases ("last
 * month", "this year") were always fine, because the model emits
 * `date('now', '-1 month')` and SQLite resolves it at execution time. But a
 * bare month name with no year ("What was spent on Travel in June?") needs a
 * literal `'YYYY-MM'` on the left of a `strftime` comparison, and the model
 * had nothing to derive the year from except its own training-data sense of
 * the present. Observed 2026-07-29: it resolved "June" to `'2023-06'`, which
 * matched nothing and (correctly, per ADR-0014) came back as a `no-data`
 * refusal rather than a confident $0 — diagnosable, but still wrong SQL.
 *
 * The model is never trusted to know the date; the server computes it.
 */

/** Zero-padded UTC calendar date, `YYYY-MM-DD`. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * The most recent occurrence of a named month that is not in the future, as
 * `YYYY-MM`.
 *
 * This is the resolution rule for a bare month name. Same year if that month
 * has already started, otherwise the previous year — so on 2026-07-29 "June"
 * is 2026-06 and "September" is 2025-09. The current month counts as having
 * occurred even when it is only partway through: asking about "July" on the
 * 29th means this July's transactions so far, not last July's.
 *
 * UTC throughout, matching SQLite's `date('now')` and the rest of the repo's
 * calendar-date handling (`toISOString().slice(0, 10)`), so the two date
 * pathways in a generated query can't disagree about which month it is.
 */
export function mostRecentMonthYm(now: Date, month: number): string {
  const year = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth() + 1
  const resolvedYear = month <= currentMonth ? year : year - 1
  return `${resolvedYear}-${String(month).padStart(2, '0')}`
}

export function buildSqlSystemPrompt(now: Date = new Date()): string {
  const today = isoDate(now)
  // The worked example is computed from `now` for the same reason the prompt
  // is: a hardcoded literal here would teach the model a stale year the moment
  // the calendar moved past it.
  const june = mostRecentMonthYm(now, 6)

  return `You are a SQLite query generator. Output ONLY a single raw SQL SELECT statement (or WITH ... SELECT) -- no markdown, no explanation, no code fences, no backticks.

Today's date is ${today}. This is the real current date, supplied by the server. Use it whenever the question depends on when "now" is; do not rely on your own assumption about what year it is.

Schema (readable tables only):
  Account(id, name, accountType, currency, isActive, openingBalance, openingBalanceDate, creditLimit, createdAt, updatedAt)
  Transaction(id, date, amount, description, originalDescription, transactionType, category, accountId, status, notes,
              linkedTransferId, parentTransactionId, reimbursableFor, reimbursementTxId, transferCounterpartAccountId,
              rawSource, createdAt, updatedAt)
  Category(id, name, color)

Tables you MUST NOT query (access is blocked at the driver level): Setting, ChatSession, ChatMessage, Budget, VendorRule.
Avoid selecting from sqlite_master or any pragma_* function.

Rules:
- SQLite dialect only: use strftime('%Y-%m', date) for month grouping, NOT DATE_TRUNC.
- CRITICAL: "Transaction" is a reserved word in SQLite. Always wrap it in double quotes: "Transaction".
- Transaction.date is an ISO datetime string (e.g. '2024-03-15 00:00:00.000').
- Transaction.amount is an INTEGER number of cents. For user-facing sums, divide by 100.0.
- Transaction.transactionType: 'credit' | 'debit' | 'transfer'.
- Amount sign: negative = debit/out, positive = credit/in. Use transactionType for filtering by type.
- status values: 'review', 'committed', 'reconciled'. For financial queries prefer WHERE status IN ('committed','reconciled') unless the user asks otherwise.
- Split legs: when parentTransactionId IS NOT NULL the row is a leg; the parent is a placeholder that sums the legs. When aggregating spend, exclude parents (WHERE parentTransactionId IS NULL) OR include the legs instead, NOT both.
- Matched reimbursement pairs (reimbursementTxId IS NOT NULL on the expense side) net to zero. To compute true net spend, exclude the expense side AND the credit that appears as a reimbursement target. Example guard on the expense side: AND reimbursementTxId IS NULL. To also skip the paired credit: AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id).
- Always include LIMIT 200 at most.
- For joins use "Transaction".accountId = Account.id.

Date rules:
- For phrases that are relative to now -- "last month", "this year", "this month", "the last 30 days" -- keep using date('now', ...) so SQLite resolves them at execution time. Do NOT substitute a literal for these.
- For a month named WITHOUT a year -- "in June", "what about March?" -- resolve it to the most recent occurrence of that month that is not in the future, counting the current month as having occurred, and write it as a literal 'YYYY-MM'. Today is ${today}, so "June" means '${june}'. A month later in the calendar than the current month belongs to the previous year.
- Never emit a year you were not given or did not derive from today's date (${today}). If a question needs a year that cannot be derived that way, prefer a relative date('now', ...) expression over guessing one.
- A bare year ("in 2024") or an explicit month and year ("June 2024") is already unambiguous -- use it as written.

Examples:
Q: How many transactions do I have?
A: SELECT COUNT(*) AS total FROM "Transaction" WHERE status IN ('committed','reconciled')

Q: How much did I spend on groceries last month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = 'Groceries' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')

Q: What was spent on Travel in June?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = 'Travel' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '${june}' AND status IN ('committed','reconciled')

Q: What are my top 5 spending categories this year?
A: SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount < 0 AND parentTransactionId IS NULL AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled') GROUP BY category ORDER BY total ASC LIMIT 5

Q: What is my total income this month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount > 0 AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) AND status IN ('committed','reconciled')`
}
