/**
 * Precision/recall measurement for the Phase A verifier (lib/chatVerification.ts,
 * ADR-0025/0026). Per docs/architecture.md's open question and this repo's own
 * memory of the arc: PR #52 shipped the verifier but nobody has ever measured
 * whether its verdicts mean anything. This is that measurement, run once
 * before any Phase B (tool-calling loop) scoping decision leans on real
 * `ChatVerdict` data.
 *
 * Method: run the verifier against two sets of (question, sql, rows) drawn
 * from scripts/chatEval/fixtureDb.ts —
 *   - GOOD: each golden query's own ground-truth SQL and the real rows it
 *     produces. Verifier should say "ok".
 *   - BROKEN: a hand-written mutation of a golden query's SQL that answers a
 *     different question than the one asked (wrong filter, lying label, or
 *     wrong shape), executed for real rows. Verifier should say "mismatch"
 *     or "out-of-scope".
 *
 * "Positive" = the verifier flagging a problem (mismatch/out-of-scope).
 *   precision = TP / (TP + FP)   — of the times it flagged a problem, how often was there really one
 *   recall    = TP / (TP + FN)   — of the real problems, how many did it catch
 *
 * Deliberately NOT a vitest test — hits a live Ollama server, same posture as
 * scripts/evalChatSql.ts.
 *
 *   npx tsx scripts/evalChatVerifier.ts [--model=qwen2.5:32b] [--url=http://localhost:11434]
 */

import { verifyResult } from '@/lib/chatVerification'
import { LLM_DEFAULTS } from '@/lib/llm-models'
import { buildFixtureDb, REFERENCE_NOW } from './chatEval/fixtureDb'
import { GOLDEN_QUERIES } from './chatEval/goldenQueries'

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string, fallback: string) =>
    args.find((a) => a.startsWith(`--${flag}=`))?.split('=').slice(1).join('=') ?? fallback
  return {
    model: get('model', LLM_DEFAULTS.sqlModel),
    url: get('url', LLM_DEFAULTS.ollamaUrl),
  }
}

type Case = {
  id: string
  question: string
  sql: string
  expected: 'ok' | 'flag'
  breakKind?: 'filter' | 'label' | 'shape'
  note: string
}

// ── GOOD cases: every golden query that has a real ground-truth SQL ────────
// (kind 'value' / 'count' / 'value-or-refusal' all carry one; 'refusal'
// fixtures never reach the verifier in the real pipeline, so they're excluded).
const GOOD_CASES: Case[] = GOLDEN_QUERIES.filter(
  (gq) => gq.expect.kind === 'value' || gq.expect.kind === 'count' || gq.expect.kind === 'value-or-refusal',
).map((gq) => ({
  id: `good:${gq.id}`,
  question: gq.question,
  sql: (gq.expect as { sql: string }).sql,
  expected: 'ok',
  note: gq.note,
}))

// ── BROKEN cases: hand-written mutations, each targeting one of the
// verifier's three named checks (FILTER / LABEL / SHAPE), so a miss is
// attributable to a specific weakness rather than "the model didn't notice".
const BROKEN_CASES: Case[] = [
  {
    id: 'broken:groceries-wrong-category',
    question: 'How much did I spend on groceries last month?',
    sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Dining' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'filter',
    note: 'Asks for groceries, SQL filters Dining — wrong category filter, rows are real dining spend.',
  },
  {
    id: 'broken:rent-wrong-month',
    question: 'What was my rent last month?',
    sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Rent' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-08'`,
    expected: 'flag',
    breakKind: 'filter',
    note: '"Last month" (July) but SQL filters August — wrong date-window filter.',
  },
  {
    id: 'broken:dining-unrequested-account-filter',
    question: 'How much did I spend on dining last month?',
    sql: `SELECT t.amount/100.0 AS total FROM "Transaction" t JOIN Account a ON t.accountId = a.id WHERE a.name = 'Rewards Card' AND t.category = 'Dining' AND t.transactionType != 'transfer' AND t.parentTransactionId IS NULL AND t.reimbursementTxId IS NULL AND strftime('%Y-%m', t.date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'filter',
    note: 'Question never named an account; SQL silently narrows to Rewards Card only.',
  },
  {
    id: 'broken:income-labeled-as-expenses',
    question: 'What were my total expenses last month?',
    sql: `SELECT SUM(amount)/100.0 AS total_expenses FROM "Transaction" WHERE amount > 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'label',
    note: 'Column aliased total_expenses but the WHERE clause (amount > 0) computes income — label lies about what it holds.',
  },
  {
    id: 'broken:transfer-volume-labeled-spend',
    question: 'How much did I move between my accounts last month?',
    sql: `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)/100.0 AS groceries_total FROM "Transaction" WHERE transactionType = 'transfer' AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'label',
    note: 'Correct transfer-volume computation, but aliased groceries_total — label names an unrelated category.',
  },
  {
    id: 'broken:average-labeled-total',
    question: 'What was my average grocery transaction last month?',
    sql: `SELECT SUM(amount)/100.0 AS average_transaction FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'label',
    note: 'Question asks for an average; SQL computes a SUM but labels it average_transaction.',
  },
  {
    id: 'broken:groceries-total-as-breakdown',
    question: 'How much did I spend on groceries last month?',
    sql: `SELECT date, amount/100.0 AS total FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'shape',
    note: 'Question asks for one figure; SQL returns a per-transaction breakdown (multiple rows) instead.',
  },
  {
    id: 'broken:transaction-count-as-list',
    question: 'How many transactions do I have?',
    sql: `SELECT id, date, amount, description FROM "Transaction" WHERE parentTransactionId IS NULL AND status IN ('committed','reconciled')`,
    expected: 'flag',
    breakKind: 'shape',
    note: 'Question asks "how many" (a count); SQL returns the full row list instead of COUNT(*).',
  },
  {
    id: 'broken:rent-year-as-single-month',
    question: 'How much did I spend on rent this year?',
    sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Rent' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'filter',
    note: '"This year" should span Jan-Aug 2026; SQL narrows to July only — misses the August rent row.',
  },
  {
    id: 'broken:income-and-expenses-income-only-mislabeled',
    question: 'What was my income and my expenses last month?',
    sql: `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)/100.0 AS total_income, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)/100.0 AS total_expenses FROM "Transaction" WHERE transactionType != 'transfer' AND parentTransactionId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'label',
    note: 'Two-column shape is right, but total_expenses is computed with the same amount > 0 branch as total_income — the expenses column is a copy of income, mislabeled.',
  },
  {
    id: 'broken:groceries-spent-alias-still-negative',
    question: 'How much did I spend on groceries last month?',
    sql: `SELECT SUM(amount)/100.0 AS total_spent FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'label',
    note: 'SIGN-PROMISE case — the only fixture that actually exercises signPromiseViolation: alias total_spent promises a positive value (per lib/chatSqlPrompt.ts\'s alias-sign rule) but the SUM was never negated, so it stays negative.',
  },
]

const ALL_CASES: Case[] = [...GOOD_CASES, ...BROKEN_CASES]

async function main() {
  const { model, url } = parseArgs()
  console.log(`[verifier-eval] model=${model} url=${url} cases=${ALL_CASES.length} (${GOOD_CASES.length} good / ${BROKEN_CASES.length} broken)\n`)

  const db = buildFixtureDb()

  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  let unusable = 0

  for (const c of ALL_CASES) {
    let rows: unknown[]
    try {
      rows = db.prepare(c.sql).all()
    } catch (e) {
      console.log(`SKIP  ${c.id} — fixture SQL failed to execute: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    const result = await verifyResult(url, model, c.question, c.sql, rows, REFERENCE_NOW, AbortSignal.timeout(30_000), '30m')
    const flagged = result.verdict === 'mismatch' || result.verdict === 'out-of-scope'

    let outcome: 'TP' | 'FP' | 'TN' | 'FN'
    if (c.expected === 'flag') {
      if (result.verdict === 'unusable') {
        unusable++
        outcome = 'FN' // an unavailable verdict caught nothing — same as missing it
        fn++
      } else if (flagged) {
        tp++
        outcome = 'TP'
      } else {
        fn++
        outcome = 'FN'
      }
    } else {
      if (flagged) {
        fp++
        outcome = 'FP'
      } else {
        tn++
        outcome = 'TN'
        if (result.verdict === 'unusable') unusable++
      }
    }

    const mark = outcome === 'TP' || outcome === 'TN' ? 'PASS' : 'MISS'
    console.log(`${mark} [${outcome}] ${c.id}`)
    console.log(`      Q: ${c.question}`)
    console.log(`      expected=${c.expected}${c.breakKind ? ` (${c.breakKind})` : ''} got=${result.verdict}${result.reason ? ` — ${result.reason}` : ''}`)
    console.log('')
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null

  console.log('─'.repeat(60))
  console.log(`Confusion: TP=${tp} FP=${fp} TN=${tn} FN=${fn} (unusable=${unusable})`)
  console.log(`Precision: ${precision === null ? 'n/a' : precision.toFixed(2)}`)
  console.log(`Recall:    ${recall === null ? 'n/a' : recall.toFixed(2)}`)

  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
