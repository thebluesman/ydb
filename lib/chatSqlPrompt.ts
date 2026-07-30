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
 *
 * It is also rebuilt per request for a second reason (ADR-0008): it carries the
 * stored `Transaction.category` vocabulary as a closed list, so the model stops
 * guessing filter literals. Both SQL passes in a turn — the first attempt and
 * the repair round-trip — are handed the string this function returns, so the
 * grounding and the date travel together and neither pass can lose one.
 */

import { NO_MATCH_SENTINEL, buildCategoryVocabularyBlock } from '@/lib/chatCategoryVocabulary'
import { descriptionSimilarity } from '@/lib/textSimilarity'

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

/**
 * A category literal for a worked example, drawn from the real vocabulary.
 *
 * The examples used to filter on the bare literals 'Groceries' and 'Travel',
 * which is precisely the guess ADR-0008 exists to stop — and an example that
 * contradicts the closed-list rule is the worst place to leave one, because
 * few-shot shape beats prose instruction. So when a vocabulary is present, the
 * examples demonstrate values from it.
 *
 * `preferred` is matched by similarity purely to keep the example readable
 * ("groceries" → '🛒 Groceries'); the answer is the *stored* string either way,
 * and when nothing resembles it the example falls back to the first stored
 * value and rewords the question to match. Similarity never picks a filter at
 * request time — only which example to print.
 */
function exampleCategory(categories: string[], preferred: string, exclude?: string): { word: string; literal: string } {
  if (categories.length === 0) return { word: preferred.toLowerCase(), literal: preferred }

  const pool = categories.filter((c) => c !== exclude)
  if (pool.length === 0) return { word: categories[0], literal: categories[0] }

  const best = pool
    .map((c) => ({ c, score: descriptionSimilarity(preferred, c) }))
    .sort((a, b) => b.score - a.score)[0]

  if (best.score >= 0.34) return { word: preferred.toLowerCase(), literal: best.c }
  return { word: pool[0], literal: pool[0] }
}

/**
 * A word for the "no corresponding category" worked example, guaranteed not to
 * collide with anything actually stored.
 *
 * Picks the first candidate that is not a substring (case-insensitive) of any
 * stored category name, so the example can never accidentally look like a
 * real match on some ledger. This only selects which word illustrates the
 * example; it plays no part in judging real questions.
 */
function noMatchExampleWord(categories: string[]): string {
  const candidates = ['Sports', 'Skydiving', 'Astrology', 'Beekeeping']
  const lower = categories.map((c) => c.toLowerCase())
  return candidates.find((w) => !lower.some((c) => c.includes(w.toLowerCase()))) ?? candidates[0]
}

export function buildSqlSystemPrompt(now: Date = new Date(), categories: string[] = []): string {
  const today = isoDate(now)
  // The worked example is computed from `now` for the same reason the prompt
  // is: a hardcoded literal here would teach the model a stale year the moment
  // the calendar moved past it.
  const june = mostRecentMonthYm(now, 6)

  const vocabularyBlock = buildCategoryVocabularyBlock(categories)
  // Empty vocabulary (a ledger with nothing categorised) renders no block and
  // no vocabulary rule — the prompt is then byte-for-byte what it was before
  // ADR-0008, rather than carrying an empty list the model has to interpret.
  const vocabularySection = vocabularyBlock ? `\n\n${vocabularyBlock}` : ''
  const groceries = exampleCategory(categories, 'Groceries')
  const travel = exampleCategory(categories, 'Travel', groceries.literal)
  const noMatchWord = noMatchExampleWord(categories)

  // Only shown when there's a vocabulary to be grounded against — with none,
  // there's no closed list for a category to fail to correspond to, and
  // ADR-0008's whole vocabulary section (including this rule) is absent.
  const noMatchExample = categories.length > 0
    ? `

Q: What was spent on ${noMatchWord} in July?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '${NO_MATCH_SENTINEL}' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '${mostRecentMonthYm(now, 7)}' AND status IN ('committed','reconciled')
-- No listed category corresponds to "${noMatchWord}". Do NOT substitute 'Uncategorized' or any other real
-- stored category as a guess -- that answers a different question. Use the sentinel literal above instead;
-- it will correctly match nothing and be refused, rather than silently returning someone else's total.`
    : ''

  return `You are a SQLite query generator. Output ONLY a single raw SQL SELECT statement (or WITH ... SELECT) -- no markdown, no explanation, no code fences, no backticks.

Today's date is ${today}. This is the real current date, supplied by the server. Use it whenever the question depends on when "now" is; do not rely on your own assumption about what year it is.

Schema (readable tables only):
  Account(id, name, accountType, currency, isActive, openingBalance, openingBalanceDate, creditLimit, createdAt, updatedAt)
  Transaction(id, date, amount, description, originalDescription, transactionType, category, accountId, status, notes,
              linkedTransferId, parentTransactionId, reimbursableFor, reimbursementTxId, transferCounterpartAccountId,
              rawSource, createdAt, updatedAt)
  Category(id, name, color)

Tables you MUST NOT query (access is blocked at the driver level): Setting, ChatSession, ChatMessage, Budget, VendorRule.
Avoid selecting from sqlite_master or any pragma_* function.${vocabularySection}

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

Balances are out of scope:
- SUM(amount) over an account is the NET FLOW across whatever period the query filters to -- money in minus money out for those dates. It is never that account's balance, and it is never the amount owed on a liability.
- Account balances, net worth and amounts outstanding are NOT derivable in SQL here. A balance is the account's opening balance combined with every transaction over its whole life under the sign rule for its account type; that arithmetic lives in application code, not in this query. If the question asks for a balance, net worth, how much is owed, how much is left, or anything that needs one, do NOT approximate it with a sum -- answer the flow question you can answer, or return the closest transaction-level aggregate.
- Account.openingBalance must NOT be selected, aggregated, or used in an expression.
- Never label a result column 'balance', 'net_worth', 'outstanding' or 'owed' (in any casing, on its own or as part of a longer name such as 'total_balance'). The column name is all the narrator sees, so a flow figure labelled as a balance is reported as one. The server rejects such a query outright rather than running it -- name a sum 'total', 'net', 'spent' or similar instead.

Date rules:
- For phrases that are relative to now -- "last month", "this year", "this month", "the last 30 days" -- keep using date('now', ...) so SQLite resolves them at execution time. Do NOT substitute a literal for these.
- For a month named WITHOUT a year -- "in June", "what about March?" -- resolve it to the most recent occurrence of that month that is not in the future, counting the current month as having occurred, and write it as a literal 'YYYY-MM'. Today is ${today}, so "June" means '${june}'. A month later in the calendar than the current month belongs to the previous year.
- Never emit a year you were not given or did not derive from today's date (${today}). If a question needs a year that cannot be derived that way, prefer a relative date('now', ...) expression over guessing one.
- A bare year ("in 2024") or an explicit month and year ("June 2024") is already unambiguous -- use it as written.

Examples:
Q: How many transactions do I have?
A: SELECT COUNT(*) AS total FROM "Transaction" WHERE status IN ('committed','reconciled')

Q: How much did I spend on ${groceries.word} last month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '${groceries.literal.replace(/'/g, "''")}' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')

Q: What was spent on ${travel.word} in June?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '${travel.literal.replace(/'/g, "''")}' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '${june}' AND status IN ('committed','reconciled')

Q: What are my top 5 spending categories this year?
A: SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount < 0 AND parentTransactionId IS NULL AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled') GROUP BY category ORDER BY total ASC LIMIT 5

Q: What is my total income this month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount > 0 AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) AND status IN ('committed','reconciled')${noMatchExample}`
}
