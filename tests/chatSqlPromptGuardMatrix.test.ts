import { describe, expect, it } from 'vitest'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'

// ─────────────────────────────────────────────────────────────────────────────
// Every worked example carries every guard applicable to its shape (ADR-0016).
//
// The two bugs fixed in PR #32 were both found by Shyam asking a question, not
// by coverage — the fourth time in this initiative (ADR-0008, ADR-0010/0015,
// ADR-0011) that a well-formed query returned a confidently wrong number and a
// human who already knew the figure was the only thing that caught it.
//
// Auditing SQL_SYSTEM_PROMPT afterwards found the guards applied unevenly across
// the worked examples: the reimbursement guard was on exactly the three
// category-filtered examples and absent from all four sign-branching aggregates,
// the paired-credit half existed only in prose, and split-leg exclusion was
// missing from the income example while three neighbours had it. Few-shot shape
// beats prose instruction (ADR-0008 says so outright), so an example missing a
// guard reads as an instruction to omit it.
//
// ADR-0016's call: split-leg and reimbursement get no route-level detector,
// because whether they apply is a relation between the SQL and the QUESTION, not
// a property of the SQL — "what did I spend" and "what was I reimbursed" produce
// the same query shape and want opposite guards. A detector would have to infer
// intent, which is the proxy ADR-0015 spent three mechanisms establishing this
// pipeline cannot make.
//
// So the protection is this file instead. It is expressible where a detector is
// not, because the prompt is our own deterministic artifact: this validates what
// we TEACH, not what the model returns. Adding an example without its guards
// fails here rather than in front of Shyam six weeks later.
//
// The two guards that ARE decidable from the SQL alone (a sign branch with no
// transactionType predicate; a bare SUM(amount) over transfer-pinned rows) get
// route-level detectors in a separate @backend-engineer ticket. They are
// asserted here too, so the prompt can never teach the shape its own detector
// would refuse.
//
// ADR-0019 (2026-08-01) widened one column of this matrix. The transfer
// exclusion used to be required only where a query branches on the sign of
// amount, which left the three category-filtered examples exempt; measuring
// prisma/dev.db showed transfer legs really do carry spend categories (loan
// repayments), so a category-filtered spend total needs the guard for the same
// reason a sign split does. It stays prompt-only and gets NO detector, for
// ADR-0016's reason unchanged: "how much did I spend on Auto loans" and "how
// much did I pay on my car loan" produce identical SQL and want opposite
// answers, so applicability is a fact about the question, not the query.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-31T09:00:00.000Z')

// A realistic stored vocabulary, so the ADR-0008 branch that renders the
// no-matching-category example is exercised rather than skipped. The examples
// are built from these literals at request time, so an unguarded example can
// hide in that branch as easily as in the static ones.
const CATEGORIES = ['🛒 Groceries', '✈️ Travel', '🚗 Auto loans', '🍽️ Dining']

// Likewise for accounts (ADR-0018): the Account-join example takes its filter
// literal from this list at request time, so rendering with a vocabulary and
// without it are two different strings and an unguarded example could hide in
// either. Shape resolution for that example is asserted separately, in
// tests/chatSqlPromptAccountJoinExample.test.ts.
const ACCOUNTS = ['ADCB Credit Card', 'ADCB, Current', 'Emirates NBD Savings']

type Example = { question: string; sql: string }

/**
 * The Q/A pairs out of the rendered prompt.
 *
 * Deliberately parsed from the finished string rather than exported as data
 * from the module: what reaches the model is the string, and a structured
 * export could drift from the text that is actually interpolated into it.
 */
function extractExamples(prompt: string): Example[] {
  const lines = prompt.split('\n')
  const out: Example[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const q = lines[i].match(/^Q: (.+)$/)
    const a = lines[i + 1].match(/^A: (.+)$/)
    if (q && a) out.push({ question: q[1], sql: a[1] })
  }
  return out
}

// ── Shape predicates ─────────────────────────────────────────────────────────

/** Branches or filters on the sign of amount — the transfer rule's ORIGINAL stated trigger. */
const branchesOnSign = (sql: string) => /amount\s*[<>]\s*0/.test(sql)

/** Transfers are the SUBJECT of the question, not something to exclude. */
const transferIsSubject = (sql: string) => /transactionType\s*=\s*'transfer'/.test(sql)

/** Aggregates money, as opposed to counting rows. */
const sumsMoney = (sql: string) => /SUM\s*\(/i.test(sql)

/** Computes a spend figure: an explicit negative-side branch, or a category-filtered total. */
const computesSpend = (sql: string) => /amount\s*<\s*0/.test(sql) || /category\s*=\s*'/.test(sql)

/**
 * Computes a money figure of the kind transfers must not contaminate — ADR-0019's
 * widened trigger. Spending, income, earnings or net flow, whether it reaches
 * that figure through a sign branch or through a category filter.
 */
const isFlowAggregate = (sql: string) => sumsMoney(sql) && (branchesOnSign(sql) || computesSpend(sql))

const has = (sql: string, re: RegExp) => re.test(sql)

const SPLIT_LEG = /parentTransactionId IS NULL/
const REIMBURSEMENT = /reimbursementTxId IS NULL/
const PAIRED_CREDIT = /NOT EXISTS\s*\(\s*SELECT 1 FROM "Transaction" x WHERE x\.reimbursementTxId = "Transaction"\.id\s*\)/
const STATUS = /status IN \('committed','reconciled'\)/
const TRANSACTION_TYPE = /transactionType\s*(!=|=|IN)/

describe('SQL prompt worked examples carry their applicable guards (ADR-0016)', () => {
  // `categoryFiltered` is the exact number of category-filtered worked examples
  // each rendering is expected to contain, stated per entry rather than derived
  // from the label. A string-match on the label put every future row into
  // whichever branch it did not match, silently handing new rows the weaker
  // bound — which is the drift this matrix exists to catch, arriving through the
  // matrix itself. Adding a row now forces a deliberate count.
  //
  // Three of the four are static (groceries, travel, and the "than usual"
  // comparative added by [chat-model] PR 4); the fourth is the ADR-0008
  // no-matching-category example, which only renders when there is a vocabulary
  // for a category to fail to correspond to. The account vocabulary adds an
  // Account-join example that filters on `a.name`, not on category, so it does
  // not move this count.
  const prompts = [
    { label: 'no stored vocabulary', prompt: buildSqlSystemPrompt(NOW), categoryFiltered: 3 },
    { label: 'with stored vocabulary', prompt: buildSqlSystemPrompt(NOW, CATEGORIES), categoryFiltered: 4 },
    {
      label: 'with stored category and account vocabulary',
      prompt: buildSqlSystemPrompt(NOW, CATEGORIES, ACCOUNTS),
      categoryFiltered: 4,
    },
  ]

  for (const { label, prompt, categoryFiltered: expectedCategoryFiltered } of prompts) {
    describe(label, () => {
      const examples = extractExamples(prompt)

      it('finds the worked examples at all', () => {
        // Guards against the parser silently matching nothing and every
        // assertion below passing vacuously.
        expect(examples.length).toBeGreaterThanOrEqual(8)
      })

      it('filters every example to committed and reconciled rows', () => {
        for (const ex of examples) {
          expect(has(ex.sql, STATUS), `status guard missing: ${ex.question}`).toBe(true)
        }
      })

      it('excludes split-leg parents wherever it aggregates', () => {
        // The parent is a placeholder that sums its legs, so counting both
        // double-counts. Exempt: the transfer-volume example, whose subject is a
        // matched pair rather than a split.
        for (const ex of examples) {
          if (transferIsSubject(ex.sql)) continue
          expect(has(ex.sql, SPLIT_LEG), `split-leg guard missing: ${ex.question}`).toBe(true)
        }
      })

      it('excludes reimbursed expenses wherever it computes spend', () => {
        for (const ex of examples) {
          if (!sumsMoney(ex.sql) || !computesSpend(ex.sql)) continue
          expect(has(ex.sql, REIMBURSEMENT), `reimbursement guard missing: ${ex.question}`).toBe(true)
        }
      })

      it('demonstrates the paired-credit half of the reimbursement guard', () => {
        // Exactly once, not everywhere. The clause is only correct for true net
        // spend and real income; teaching it on every example would attach it to
        // questions about reimbursements themselves, where it removes the very
        // rows being asked about.
        const withPairedCredit = examples.filter((ex) => has(ex.sql, PAIRED_CREDIT))
        expect(withPairedCredit).toHaveLength(1)
      })

      it('names a transactionType wherever it computes a spending or flow figure', () => {
        // The first of the two PR #32 bugs, with ADR-0019's widened trigger. A
        // sign split with no transactionType predicate counts the outgoing leg of
        // a transfer as an expense and the incoming leg as income, inflating both
        // by the same amount. Some predicate is required, not a specific one —
        // the transfer-volume example passes on `= 'transfer'`.
        //
        // ADR-0019 moved this column from `n/a` to required on the CATEGORY-
        // filtered rows too, which used to be exempt because they never mention
        // the sign of amount. Measured against prisma/dev.db on 2026-08-01: all
        // 44 transfer rows carry a category and 5 carry a real spend category
        // (3 `🚗 Auto loans`, 2 `💰 Personal loans`), assigned upstream by the
        // SMS-capture pipeline. Worse than the double-count, not milder — the
        // category is on the outgoing leg only and the counterpart is
        // `Uncategorized`, so nothing cancels and the full amount moved comes
        // back as spending. The sign branch was the SYMPTOM in PR #32, never the
        // reason; the reason is that a transfer is not spending.
        for (const ex of examples) {
          if (!isFlowAggregate(ex.sql)) continue
          expect(has(ex.sql, TRANSACTION_TYPE), `transactionType guard missing: ${ex.question}`).toBe(true)
        }
      })

      it('guards the category-filtered spend examples specifically (ADR-0019)', () => {
        // Stated as its own assertion rather than left implicit in the loop
        // above: these are the three examples ADR-0019 changed, and a predicate
        // drifting such that they stop being selected would silently restore the
        // exemption. `CATEGORIES` includes `🚗 Auto loans` so the rendered
        // examples are built from a vocabulary that really does collide.
        //
        // Exact, not a lower bound: the count comes from the `prompts` entry, so
        // a rendering that gains or loses a category-filtered example has to say
        // so there rather than slipping under a `>=`.
        const categoryFiltered = examples.filter((ex) => /category\s*=\s*'/.test(ex.sql))
        expect(categoryFiltered.length).toBe(expectedCategoryFiltered)
        for (const ex of categoryFiltered) {
          expect(has(ex.sql, /transactionType != 'transfer'/), `transfer exclusion missing: ${ex.question}`).toBe(true)
        }
      })

      it('never sums transfer rows bare', () => {
        // The second PR #32 bug. The legs of a transfer are equal and opposite,
        // so SUM(amount) over transfer-pinned rows cancels to approximately zero
        // for any ledger however much moved — a confident, well-formed zero.
        for (const ex of examples) {
          if (!transferIsSubject(ex.sql)) continue
          expect(/SUM\s*\(\s*amount\s*\)/i.test(ex.sql), `bare transfer sum: ${ex.question}`).toBe(false)
          expect(/SUM\s*\(\s*CASE WHEN amount > 0/i.test(ex.sql)).toBe(true)
        }
      })

      it('converts cents to a user-facing figure wherever it sums money', () => {
        for (const ex of examples) {
          if (!sumsMoney(ex.sql)) continue
          expect(has(ex.sql, /\/ 100\.0/), `cents conversion missing: ${ex.question}`).toBe(true)
        }
      })

      it('never demonstrates a compound SELECT', () => {
        // ADR-0011 cross-check: the route rejects these outright, so an example
        // teaching one would train the model straight into a refusal.
        for (const ex of examples) {
          expect(/\b(UNION|INTERSECT|EXCEPT)\b/i.test(ex.sql), `compound SELECT: ${ex.question}`).toBe(false)
        }
      })

      it('never selects openingBalance or labels a figure as a balance', () => {
        // ADR-0010's checks survive as ADR-0015's second net; same reasoning as
        // the compound-SELECT case.
        for (const ex of examples) {
          expect(/openingBalance/i.test(ex.sql), `openingBalance: ${ex.question}`).toBe(false)
          expect(/AS \w*(balance|net_worth|outstanding|owed)/i.test(ex.sql), `balance alias: ${ex.question}`).toBe(false)
        }
      })
    })
  }
})

describe('the guard matrix is actually load-bearing', () => {
  // A matrix that passes against anything is worse than none: it reads as
  // coverage while asserting nothing. These pin the predicates to known-bad SQL,
  // so a regex that stops matching is caught here rather than by silently
  // waving every example through above.
  const UNGUARDED_SIGN_SPLIT =
    `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income FROM "Transaction" ` +
    `WHERE strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled')`

  const BARE_TRANSFER_SUM =
    `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE transactionType = 'transfer' ` +
    `AND status IN ('committed','reconciled')`

  /**
   * ADR-0019's shape: a category-filtered spend total with no sign comparison
   * anywhere. This is what the three worked examples looked like before this
   * ticket, and it is the mutation the matrix now catches — drop
   * `AND transactionType != 'transfer'` from an example and it renders as this.
   */
  const UNGUARDED_CATEGORY_SPEND =
    `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🚗 Auto loans' ` +
    `AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND status IN ('committed','reconciled')`

  it('recognises a sign branch with no transactionType predicate', () => {
    expect(branchesOnSign(UNGUARDED_SIGN_SPLIT)).toBe(true)
    expect(has(UNGUARDED_SIGN_SPLIT, TRANSACTION_TYPE)).toBe(false)
  })

  it('recognises a bare sum over transfer rows', () => {
    expect(transferIsSubject(BARE_TRANSFER_SUM)).toBe(true)
    expect(/SUM\s*\(\s*amount\s*\)/i.test(BARE_TRANSFER_SUM)).toBe(true)
  })

  it('recognises a category-filtered spend total with no transfer exclusion (ADR-0019)', () => {
    // The trigger must fire on this even though `branchesOnSign` does not — that
    // gap is precisely what ADR-0019 closed. If `isFlowAggregate` ever narrows
    // back to the sign branch, this goes red instead of the matrix quietly
    // waving the category examples through.
    expect(branchesOnSign(UNGUARDED_CATEGORY_SPEND)).toBe(false)
    expect(isFlowAggregate(UNGUARDED_CATEGORY_SPEND)).toBe(true)
    expect(has(UNGUARDED_CATEGORY_SPEND, TRANSACTION_TYPE)).toBe(false)
  })

  it('a counting query over a category is not treated as a flow aggregate', () => {
    // Over-rejection check on the widened trigger: COUNT(*) is not a money
    // figure, so a transfer row inside it is not a wrong number.
    const countByCategory =
      `SELECT COUNT(*) AS n FROM "Transaction" WHERE category = '🚗 Auto loans' AND status IN ('committed','reconciled')`
    expect(isFlowAggregate(countByCategory)).toBe(false)
  })

  it('does not mistake an exclusion guard for a transfer subject', () => {
    expect(transferIsSubject(`WHERE transactionType != 'transfer'`)).toBe(false)
  })

  it('accepts either direction of transactionType predicate', () => {
    expect(has(`WHERE transactionType != 'transfer'`, TRANSACTION_TYPE)).toBe(true)
    expect(has(`WHERE transactionType = 'transfer'`, TRANSACTION_TYPE)).toBe(true)
    expect(has(`WHERE transactionType IN ('credit','debit')`, TRANSACTION_TYPE)).toBe(true)
  })
})
