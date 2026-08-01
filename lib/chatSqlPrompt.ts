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
import { buildAccountVocabularyBlock } from '@/lib/chatAccountVocabulary'
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
 * An account literal for the `Account`-join worked example, drawn from the real
 * stored vocabulary.
 *
 * Same device as `exampleCategory` and for the same reason (ADR-0008, applied to
 * the second column by ADR-0018): an example that hardcodes an account name the
 * ledger does not have demonstrates the exact guess the closed-list rule exists
 * to stop, and few-shot shape beats prose.
 *
 * `preferred` is 'Credit Card' because that is the wording session 10 actually
 * used ("credit card"), which is a description of an account type rather than a
 * stored name — the case the example most needs to teach. Similarity picks only
 * which stored value illustrates the example, never a filter literal at request
 * time; when nothing resembles `preferred` the example falls back to the first
 * stored account and rewords the question to match.
 */
function exampleAccount(accounts: string[], preferred: string): { word: string; literal: string } {
  if (accounts.length === 0) return { word: preferred.toLowerCase(), literal: preferred }

  const best = accounts
    .map((a) => ({ a, score: descriptionSimilarity(preferred, a) }))
    .sort((x, y) => y.score - x.score)[0]

  if (best.score >= 0.34) return { word: preferred.toLowerCase(), literal: best.a }
  return { word: accounts[0], literal: accounts[0] }
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

export function buildSqlSystemPrompt(
  now: Date = new Date(),
  categories: string[] = [],
  accounts: string[] = [],
): string {
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

  // Account names get the same closed-list treatment as categories, for the same
  // reason and by the same mechanism (see lib/chatAccountVocabulary.ts). Rendered
  // as its own block rather than merged into the category one: they are two
  // different columns with two different exact-copy rules, and one combined list
  // would invite the model to filter a name against the category column.
  const accountBlock = buildAccountVocabularyBlock(accounts)
  const accountSection = accountBlock ? `\n\n${accountBlock}` : ''
  const groceries = exampleCategory(categories, 'Groceries')
  const travel = exampleCategory(categories, 'Travel', groceries.literal)
  const noMatchWord = noMatchExampleWord(categories)
  // The Account-join example. Its shape is load-bearing, not stylistic: the
  // aliased form is one `accountNameScope` in lib/chatAccountVocabulary.ts
  // actually resolves, and the unaliased `FROM "Transaction" JOIN Account ON ...`
  // form this file used to instruct in prose alone is one it does NOT (its
  // FROM/JOIN regex consumes the JOIN keyword as the first table's alias, so the
  // Account source is never seen and the grounding check silently fails open).
  // tests/chatSqlPromptAccountJoinExample.test.ts pins both halves of that.
  const account = exampleAccount(accounts, 'Credit Card')

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
Avoid selecting from sqlite_master or any pragma_* function.${vocabularySection}${accountSection}

Rules:
- SQLite dialect only: use strftime('%Y-%m', date) for month grouping, NOT DATE_TRUNC.
- CRITICAL: "Transaction" is a reserved word in SQLite. Always wrap it in double quotes: "Transaction".
- Transaction.date is an ISO datetime string (e.g. '2024-03-15 00:00:00.000').
- Transaction.amount is an INTEGER number of cents. For user-facing sums, divide by 100.0.
- Transaction.transactionType: 'credit' | 'debit' | 'transfer'.
- Amount sign: negative = debit/out, positive = credit/in. Use transactionType for filtering by type.
- Transfers are NEITHER income NOR spending: a transfer moves money between the user's own accounts and is stored as two rows, one negative leg and one positive leg. A bare sign split therefore counts the outgoing leg as an expense AND the incoming leg as income, inflating both totals by the same amount even though the pair nets to zero. Any income, expense, spending, earnings or net-flow aggregate MUST exclude them: AND transactionType != 'transfer' (equivalently AND transactionType IN ('credit','debit')). This applies whenever the query filters or branches on the sign of amount.
- The mirror case: when the question is specifically ABOUT transfers -- "how much did I move between my accounts", "how much did I transfer" -- the answer is the VOLUME moved, and a bare SUM(amount) over transactionType = 'transfer' rows CANNOT compute it. The two legs of a transfer are equal and opposite, so they cancel: that sum always evaluates to (approximately) zero no matter how much money actually moved. Zero there is an artefact of how a transfer is stored, not a fact about the ledger. Sum the INFLOW legs only instead: SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0. Each transfer contributes exactly one positive leg whose size is the amount transferred, so that total is the volume moved, counted once. (SUM(ABS(amount)) / 2 is arithmetically the same thing; prefer the CASE form.)
- status values: 'review', 'committed', 'reconciled'. For financial queries prefer WHERE status IN ('committed','reconciled') unless the user asks otherwise.
- Split legs: when parentTransactionId IS NOT NULL the row is a leg; the parent is a placeholder that sums the legs. When aggregating spend, exclude parents (WHERE parentTransactionId IS NULL) OR include the legs instead, NOT both.
- Matched reimbursement pairs (reimbursementTxId IS NOT NULL on the expense side) net to zero. To compute true net spend, exclude the expense side AND the credit that appears as a reimbursement target. Example guard on the expense side: AND reimbursementTxId IS NULL. To also skip the paired credit: AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id).
- Always include LIMIT 200 at most.
- For joins use "Transaction".accountId = Account.id. When the join exists so you can filter on an account's NAME, write it with short aliases and qualify the name column: FROM "Transaction" t JOIN Account a ON t.accountId = a.id ... WHERE a.name = '...'. A bare unqualified name in a joined query is ambiguous -- Category.name exists too -- so qualify it always. See the account-filtered worked example below.

One row, one column per figure -- never a compound SELECT:
- NEVER use UNION, UNION ALL, INTERSECT or EXCEPT. Not for any question, not even to stack two aggregates.
- SQLite names a compound result set after its FIRST branch only, whichever of those operators joined the branches. "SELECT SUM(...) AS total_expenses ... UNION ALL SELECT SUM(...) AS total_income ..." returns BOTH rows labelled total_expenses, so the income figure is reported as an expense. The column name is all the narrator sees, so that mislabelling becomes a confidently self-contradictory answer.
- A question asking for several figures is answered with several aliased columns in ONE row, using conditional aggregates. See the multi-figure example below.
- The server rejects any query containing a compound SELECT outright rather than running it.

Balances are out of scope:
- SUM(amount) over an account is the NET FLOW across whatever period the query filters to -- money in minus money out for those dates. It is never that account's balance, and it is never the amount owed on a liability.
- Account balances, net worth and amounts outstanding are NOT derivable in SQL here. A balance is the account's opening balance combined with every transaction over its whole life under the sign rule for its account type; that arithmetic lives in application code, not in this query. If the question asks for a balance, net worth, how much is owed, how much is left, or anything that needs one, do NOT approximate it with a sum -- answer the flow question you can answer, or return the closest transaction-level aggregate.
- Account.openingBalance must NOT be selected, aggregated, or used in an expression.
- Never use SELECT * (or SELECT a.*) on Account. A star projection returns openingBalance without naming it, and the server rejects any result set that comes back carrying that column. List the columns you actually need instead.
- Never label a result column 'balance', 'net_worth', 'outstanding' or 'owed' (in any casing, on its own or as part of a longer name such as 'total_balance'). The column name is all the narrator sees, so a flow figure labelled as a balance is reported as one. The server rejects such a query outright rather than running it -- name a sum 'total', 'net', 'spent' or similar instead.

Date rules:
- For phrases that are relative to now -- "last month", "this year", "this month", "the last 30 days" -- keep using date('now', ...) so SQLite resolves them at execution time. Do NOT substitute a literal for these.
- For a month named WITHOUT a year -- "in June", "what about March?" -- resolve it to the most recent occurrence of that month that is not in the future, counting the current month as having occurred, and write it as a literal 'YYYY-MM'. Today is ${today}, so "June" means '${june}'. A month later in the calendar than the current month belongs to the previous year.
- Never emit a year you were not given or did not derive from today's date (${today}). If a question needs a year that cannot be derived that way, prefer a relative date('now', ...) expression over guessing one.
- A bare year ("in 2024") or an explicit month and year ("June 2024") is already unambiguous -- use it as written.

Examples:
Q: How many transactions do I have?
A: SELECT COUNT(*) AS total FROM "Transaction" WHERE parentTransactionId IS NULL AND status IN ('committed','reconciled')

Q: How much did I spend on ${groceries.word} last month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '${groceries.literal.replace(/'/g, "''")}' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')

Q: What was spent on ${travel.word} in June?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '${travel.literal.replace(/'/g, "''")}' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '${june}' AND status IN ('committed','reconciled')

Q: How much did I spend on my ${account.word} last month?
A: SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t JOIN Account a ON t.accountId = a.id WHERE a.name = '${account.literal.replace(/'/g, "''")}' AND t.amount < 0 AND t.transactionType != 'transfer' AND t.parentTransactionId IS NULL AND t.reimbursementTxId IS NULL AND strftime('%Y-%m', t.date) = strftime('%Y-%m', date('now','-1 month')) AND t.status IN ('committed','reconciled')
-- Filtering by account means joining Account; this is the shape to copy. Both tables get a short alias
-- and the name column is written QUALIFIED (a.name), never bare: Category.name exists too, so an
-- unqualified name in a joined query is ambiguous and the server cannot tell it is an account filter.
-- The literal is copied exactly from the account vocabulary. Do NOT filter on a description of an
-- account type -- a.name LIKE '%credit card%' is valid SQL that matches nothing on a ledger whose cards
-- are named after their banks, and an empty result is not "nothing was spent".
-- Never SELECT * or a.* here: a star projection returns openingBalance without naming it and the
-- server rejects the result set. Project only the figure you need.
-- The transfer guard is not optional even though the question named no sign: money moved onto or off
-- this account is stored as a transfer leg, and counting it as spending inflates the total.

Q: What are my top 5 spending categories this year?
A: SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled') GROUP BY category ORDER BY total ASC LIMIT 5

Q: What is my total income this month?
A: SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount > 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) AND status IN ('committed','reconciled')

Q: How much did I earn and how much did I spend last month?
A: SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income FROM "Transaction" WHERE transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id) AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND status IN ('committed','reconciled')
-- Two figures, two aliased columns, ONE row. Do NOT write this as two SELECTs joined by UNION ALL:
-- the second alias would be discarded and both numbers would come back labelled total_expenses.
-- The transactionType guard is not optional: without it every transfer leg is counted, once as
-- income and once as an expense, and both figures come back too high by the same amount.
-- This example carries BOTH halves of the reimbursement guard, because it reports an expense figure
-- and an income figure together. reimbursementTxId IS NULL drops the expense that was paid back;
-- the NOT EXISTS drops the credit that paid it back, which is not income. Dropping only one half
-- leaves the pair half-counted, so net spend looks too low or income looks too high. Use both halves
-- only when the question is about true net spend or real income -- a question ABOUT reimbursements
-- ("how much was I paid back") wants exactly the rows these two clauses remove, so it uses neither.

Q: What's my total income and total expenses this year?
A: SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses FROM "Transaction" WHERE transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled')

Q: How much did I move between my accounts this year?
A: SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total FROM "Transaction" WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled')
-- This question wants the transfer total, so here transfers are the subject rather than something to
-- exclude -- but do NOT write it as SUM(amount) over transactionType = 'transfer'. Every transfer is a
-- matched pair of equal and opposite legs, so that sum cancels to (approximately) zero for any ledger,
-- however much was moved. Summing only the positive legs counts each transfer exactly once.${noMatchExample}`
}
