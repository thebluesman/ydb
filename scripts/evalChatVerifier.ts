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

import { signPromiseViolation, VERIFY_TIMEOUT_MS, verifyResult } from '@/lib/chatVerification'
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
// (kind 'value' / 'count' / 'value-or-refusal' / 'columns' all carry one;
// 'refusal' fixtures never reach the verifier in the real pipeline, so
// they're excluded).
const GOOD_CASES: Case[] = GOLDEN_QUERIES.filter(
  (gq) =>
    gq.expect.kind === 'value' ||
    gq.expect.kind === 'count' ||
    gq.expect.kind === 'value-or-refusal' ||
    gq.expect.kind === 'columns',
).map((gq) => ({
  id: `good:${gq.id}`,
  question: gq.question,
  sql: (gq.expect as { sql: string }).sql,
  expected: 'ok',
  note: gq.note,
}))

// None of GOLDEN_QUERIES' own ground-truth SQL uses a "spent"/"spending"
// alias (they're all plain `total`/`total_income`), which meant the first
// version of this harness never exercised signPromiseViolation's false-
// positive rate at all — only its true-positive rate, via one BROKEN case.
// These two are in the exact form lib/chatSqlPrompt.ts's alias-sign rule
// teaches the generator to produce for a spend question: SUM(-amount),
// positive, aliased total_spent. The pre-check must NOT fire on these; if it
// does, that's a real regression, not a model-precision finding.
const GOOD_SIGN_PROMISE_CASES: Case[] = [
  {
    id: 'good:groceries-total-spent-taught-form',
    question: 'How much did I spend on groceries last month?',
    sql: `SELECT SUM(-amount)/100.0 AS total_spent FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'ok',
    note: 'Taught alias-sign form (SUM(-amount) AS total_spent, positive) — must not trip signPromiseViolation.',
  },
  {
    id: 'good:rent-total-spent-taught-form',
    question: 'What was my rent last month?',
    sql: `SELECT SUM(-amount)/100.0 AS total_spent FROM "Transaction" WHERE category = 'Rent' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    expected: 'ok',
    note: 'Same taught form, single-row category — sanity check alongside the multi-row groceries case above.',
  },
]

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
    sql: `SELECT SUM(t.amount)/100.0 AS total FROM "Transaction" t JOIN Account a ON t.accountId = a.id WHERE a.name = 'Rewards Card' AND t.category = 'Dining' AND t.transactionType != 'transfer' AND t.parentTransactionId IS NULL AND t.reimbursementTxId IS NULL AND strftime('%Y-%m', t.date) = '2026-07'`,
    expected: 'flag',
    breakKind: 'filter',
    note: 'Question never named an account; SQL silently narrows to Rewards Card only. SUM restored (an earlier version of this fixture dropped it, conflating the filter break with an accidental shape break).',
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

const ALL_CASES: Case[] = [...GOOD_CASES, ...GOOD_SIGN_PROMISE_CASES, ...BROKEN_CASES]

type Source = 'precheck' | 'model'

function classify(expected: 'ok' | 'flag', flagged: boolean, unusableHit: boolean): 'TP' | 'FP' | 'TN' | 'FN' {
  if (expected === 'flag') {
    if (unusableHit) return 'FN' // an unavailable verdict caught nothing — same as missing it
    return flagged ? 'TP' : 'FN'
  }
  return flagged ? 'FP' : 'TN'
}

/** Accumulates TP/FP/TN/FN for one metrics bucket (combined, precheck-only, model-only). */
class Tally {
  tp = 0
  fp = 0
  tn = 0
  fn = 0
  unusable = 0

  record(outcome: 'TP' | 'FP' | 'TN' | 'FN', unusableHit: boolean) {
    this[outcome.toLowerCase() as 'tp' | 'fp' | 'tn' | 'fn']++
    if (unusableHit) this.unusable++
  }

  get precision(): number | null {
    return this.tp + this.fp > 0 ? this.tp / (this.tp + this.fp) : null
  }

  get recall(): number | null {
    return this.tp + this.fn > 0 ? this.tp / (this.tp + this.fn) : null
  }

  report(label: string) {
    const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2))
    console.log(`${label}: TP=${this.tp} FP=${this.fp} TN=${this.tn} FN=${this.fn} (unusable=${this.unusable}) — precision=${fmt(this.precision)} recall=${fmt(this.recall)}`)
  }
}

async function main() {
  const { model, url } = parseArgs()
  console.log(`[verifier-eval] model=${model} url=${url} cases=${ALL_CASES.length} (${GOOD_CASES.length + GOOD_SIGN_PROMISE_CASES.length} good / ${BROKEN_CASES.length} broken)\n`)

  const db = buildFixtureDb()

  // Combined = what the pipeline actually does (route guard, then model).
  // Precheck/model are reported separately per tech-lead review of PR #53:
  // mixing them lets a future deterministic guard addition inflate "verifier
  // accuracy" without the model's own judgment improving at all.
  const combined = new Tally()
  const precheck = new Tally()
  const modelOnly = new Tally()

  for (const c of ALL_CASES) {
    let rows: unknown[]
    try {
      rows = db.prepare(c.sql).all()
    } catch (e) {
      console.log(`SKIP  ${c.id} — fixture SQL failed to execute: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    // Mirrors app/api/chat/route.ts: signPromiseViolation is checked BEFORE
    // verifyResult is ever called, not inside it (ADR-0025 addendum,
    // 2026-08-04) — a turn caught here never reaches the model.
    const signViolation = signPromiseViolation(rows)
    let source: Source
    let verdict: string
    let reason: string | null
    let flagged: boolean
    let unusableHit = false

    if (signViolation) {
      source = 'precheck'
      verdict = 'mismatch (precheck)'
      reason = `column "${signViolation.column}" is negative`
      flagged = true
    } else {
      source = 'model'
      const result = await verifyResult(
        url, model, c.question, c.sql, rows, REFERENCE_NOW, AbortSignal.timeout(VERIFY_TIMEOUT_MS), '30m',
      )
      verdict = result.verdict
      reason = result.reason
      flagged = result.verdict === 'mismatch' || result.verdict === 'out-of-scope'
      unusableHit = result.verdict === 'unusable'
    }

    const outcome = classify(c.expected, flagged, unusableHit)
    combined.record(outcome, unusableHit)
    ;(source === 'precheck' ? precheck : modelOnly).record(outcome, unusableHit)

    const mark = outcome === 'TP' || outcome === 'TN' ? 'PASS' : 'MISS'
    console.log(`${mark} [${outcome}/${source}] ${c.id}`)
    console.log(`      Q: ${c.question}`)
    console.log(`      expected=${c.expected}${c.breakKind ? ` (${c.breakKind})` : ''} got=${verdict}${reason ? ` — ${reason}` : ''}`)
    console.log('')
  }

  console.log('─'.repeat(60))
  combined.report('Combined (what the pipeline actually does)')
  precheck.report('Precheck only (signPromiseViolation)')
  modelOnly.report('Model only (verifyResult)')

  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
