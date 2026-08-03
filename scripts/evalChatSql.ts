/**
 * [chat-eval] golden-query eval harness for the chat text-to-SQL path.
 *
 * Answers the question ADR-0006 and this ticket both flag as open: "is the
 * current chat model good enough at text-to-SQL" — something other than
 * vibes. Runs each question in scripts/chatEval/goldenQueries.ts through the
 * REAL SQL-generation prompt (lib/chatSqlPrompt.ts) against a real Ollama
 * server, through the REAL guard chain (every function below is imported live
 * from lib/, not reimplemented), against a small fixture ledger with known,
 * hand-verified contents (scripts/chatEval/fixtureDb.ts), and checks the
 * result against a ground-truth SQL query.
 *
 * Deliberately NOT a vitest test: this hits a live model over the network,
 * takes real wall-clock time, and its outcome depends on which model is
 * configured — none of which belongs in `npm test`. Run directly:
 *
 *   npx tsx scripts/evalChatSql.ts [--model=qwen2.5:32b] [--url=http://localhost:11434]
 *
 * KNOWN LIMITATION: this reimplements route.ts's GUARD ORDER as a thin
 * driver, calling the same guard functions app/api/chat/route.ts calls, in
 * the same sequence, but is not the route handler itself (lib/prisma.ts's
 * DB_PATH is hardcoded to prisma/dev.db, which this harness must never touch
 * — pointing the real route at a fixture DB would mean contorting a module
 * AGENTS.md protects as a safety boundary, exactly what this harness should
 * not risk). If route.ts's guard order or set changes, this file needs a
 * matching update — it will not drift silently in the sense of testing wrong
 * guard LOGIC (that's imported live), only possibly wrong guard ORDER or a
 * newly-added guard this file doesn't yet call.
 */

import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'
import { loadCategoryVocabulary, unknownCategoryLiterals } from '@/lib/chatCategoryVocabulary'
import { loadAccountVocabulary, unknownAccountLiterals } from '@/lib/chatAccountVocabulary'
import { balanceIntentMatch } from '@/lib/chatBalanceIntent'
import { balanceScopeRowViolation, balanceScopeViolation } from '@/lib/chatBalanceScope'
import { compoundSelectViolation } from '@/lib/chatCompoundSelect'
import { signBranchGuardViolation, transferSumViolation } from '@/lib/chatMoneyGuards'
import { applyMoneyUnits, moneyUnitsPlan } from '@/lib/chatMoneyUnits'
import { isNoDataResult } from '@/lib/chatNonAnswer'
import { LLM_DEFAULTS } from '@/lib/llm-models'
import {
  buildFixtureDb,
  fixtureAccountSource,
  fixtureCategorySource,
  REFERENCE_NOW,
} from './chatEval/fixtureDb'
import { GOLDEN_QUERIES, groundTruthValue, type GoldenQuery } from './chatEval/goldenQueries'

// Same JSON-schema constraint as app/api/chat/route.ts's SQL_FORMAT ([chat-perf]).
// Not imported — that constant isn't exported, and duplicating four lines here
// is lower-risk than exporting an internal route detail for one script.
const SQL_FORMAT = { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } as const

function extractSql(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.sql === 'string') return parsed.sql.trim()
  } catch {
    // Not JSON — fall through to the pre-format fallback.
  }
  return raw.replace(/^```[\w]*\n?/i, '').replace(/\n?```$/i, '').trim()
}

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string, fallback: string) =>
    args.find((a) => a.startsWith(`--${flag}=`))?.split('=').slice(1).join('=') ?? fallback
  return {
    model: get('model', LLM_DEFAULTS.sqlModel),
    url: get('url', LLM_DEFAULTS.ollamaUrl),
  }
}

async function callOllama(url: string, model: string, system: string, prompt: string): Promise<string> {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system,
      prompt,
      format: SQL_FORMAT,
      stream: false,
      options: { temperature: 0, num_ctx: 16384 },
    }),
  })
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`)
  const json = await res.json()
  const raw = (json.response as string ?? '').trim()
  let sql = extractSql(raw)
  sql = sql.replace(/\bFROM\s+Transaction\b/gi, 'FROM "Transaction"')
  sql = sql.replace(/\bJOIN\s+Transaction\b/gi, 'JOIN "Transaction"')
  return sql
}

type GuardOutcome = { refused: true; reason: string } | { refused: false }

/** Same guard chain and order as app/api/chat/route.ts's pre-execution checks. */
function checkGuards(sql: string, categories: string[], accounts: string[]): GuardOutcome {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return { refused: true, reason: 'not a SELECT/WITH statement' }
  const cat = unknownCategoryLiterals(sql, categories)
  if (cat.length > 0) return { refused: true, reason: `unknown category literal: ${cat.join(', ')}` }
  const acct = unknownAccountLiterals(sql, accounts)
  if (acct.length > 0) return { refused: true, reason: `unknown account literal: ${acct.join(', ')}` }
  const scope = balanceScopeViolation(sql)
  if (scope) return { refused: true, reason: `balance-scope violation: ${scope.kind}` }
  const compound = compoundSelectViolation(sql)
  if (compound) return { refused: true, reason: 'compound SELECT' }
  const signBranch = signBranchGuardViolation(sql)
  if (signBranch) return { refused: true, reason: 'sign-branch guard' }
  const transferSum = transferSumViolation(sql)
  if (transferSum) return { refused: true, reason: 'transfer-sum guard' }
  if (moneyUnitsPlan(sql).kind === 'refuse') return { refused: true, reason: 'money-units unresolvable' }
  return { refused: false }
}

type RunOutcome =
  | { kind: 'refused'; reason: string; sql?: string }
  | { kind: 'answered'; sql: string; rows: unknown[] }
  | { kind: 'error'; message: string; sql?: string }

async function runQuestion(
  db: ReturnType<typeof buildFixtureDb>,
  url: string,
  model: string,
  categories: string[],
  accounts: string[],
  gq: GoldenQuery,
): Promise<RunOutcome> {
  const balanceIntent = balanceIntentMatch(gq.question)
  if (balanceIntent) return { kind: 'refused', reason: `balance intent: ${balanceIntent.phrase}` }

  const system = buildSqlSystemPrompt(REFERENCE_NOW, categories, accounts)
  const historyText = (gq.history ?? [])
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n')
  const prompt = historyText ? `${historyText}\nUser: ${gq.question}` : gq.question

  let sql: string
  try {
    sql = await callOllama(url, model, system, prompt)
  } catch (e) {
    return { kind: 'error', message: `SQL generation failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  let guard = checkGuards(sql, categories, accounts)
  if (guard.refused) return { kind: 'refused', reason: guard.reason, sql }

  let rows: unknown[]
  try {
    rows = db.prepare(sql).all()
  } catch (err) {
    // One repair round-trip, same as the route.
    const firstMsg = err instanceof Error ? err.message : String(err)
    const repairPrompt =
      `${prompt}\n\nYou previously generated this SQLite query:\n${sql}\n\n` +
      `Executing it failed with this error:\n${firstMsg}\n\n` +
      `Return a corrected SQLite SELECT (or WITH ... SELECT) that fixes the error, ` +
      `as a JSON object of the form {"sql": "<statement>"}.`

    let repaired: string
    try {
      repaired = await callOllama(url, model, system, repairPrompt)
    } catch (e) {
      return { kind: 'error', message: `Repair round-trip failed: ${e instanceof Error ? e.message : String(e)}`, sql }
    }

    guard = checkGuards(repaired, categories, accounts)
    if (guard.refused) return { kind: 'refused', reason: guard.reason, sql: repaired }

    try {
      rows = db.prepare(repaired).all()
      sql = repaired
    } catch (err2) {
      return { kind: 'error', message: `SQL error after repair: ${err2 instanceof Error ? err2.message : String(err2)}`, sql: repaired }
    }
  }

  const scopeRows = balanceScopeRowViolation(rows)
  if (scopeRows) return { kind: 'refused', reason: `balance-scope row violation: ${scopeRows.kind}`, sql }

  rows = applyMoneyUnits(rows, moneyUnitsPlan(sql))

  if (isNoDataResult(rows)) return { kind: 'refused', reason: 'no-data', sql }

  return { kind: 'answered', sql, rows }
}

function extractSingleValue(rows: unknown[]): number | null {
  if (rows.length === 0) return null
  const row = rows[0] as Record<string, unknown>
  const value = Object.values(row)[0]
  return typeof value === 'number' ? value : null
}

type Verdict = 'pass' | 'fail' | 'error'

function judge(gq: GoldenQuery, outcome: RunOutcome, db: ReturnType<typeof buildFixtureDb>): { verdict: Verdict; detail: string } {
  if (outcome.kind === 'error') return { verdict: 'error', detail: outcome.message }

  if (gq.expect.kind === 'refusal') {
    return outcome.kind === 'refused'
      ? { verdict: 'pass', detail: `correctly refused (${outcome.reason})` }
      : { verdict: 'fail', detail: `expected a refusal, got an answer: ${JSON.stringify((outcome as { rows: unknown[] }).rows)}` }
  }

  if (outcome.kind === 'refused') {
    if (gq.expect.kind === 'value-or-refusal') {
      return { verdict: 'pass', detail: `refused (${outcome.reason}) — acceptable for this fixture` }
    }
    return { verdict: 'fail', detail: `unexpectedly refused: ${outcome.reason}` }
  }

  const actual = extractSingleValue(outcome.rows)
  if (actual === null) {
    return { verdict: 'fail', detail: `no numeric value in result: ${JSON.stringify(outcome.rows)}` }
  }

  const expectedValue = groundTruthValue(db, (gq.expect as { sql: string }).sql)
  if (expectedValue === null) throw new Error(`ground truth for ${gq.id} did not produce a number`)

  const tolerance = 'tolerance' in gq.expect ? (gq.expect.tolerance ?? 0.01) : gq.expect.kind === 'count' ? 0 : 0.01
  const signInsensitive = 'signInsensitive' in gq.expect && gq.expect.signInsensitive
  const a = signInsensitive ? Math.abs(actual) : actual
  const e = signInsensitive ? Math.abs(expectedValue) : expectedValue
  const pass = Math.abs(a - e) <= tolerance

  return {
    verdict: pass ? 'pass' : 'fail',
    detail: pass ? `${actual} ≈ ${expectedValue}` : `expected ${expectedValue}, got ${actual}`,
  }
}

async function main() {
  const { model, url } = parseArgs()
  console.log(`[chat-eval] model=${model} url=${url} questions=${GOLDEN_QUERIES.length}\n`)

  const db = buildFixtureDb()
  const categories = await loadCategoryVocabulary(fixtureCategorySource(db))
  const accounts = await loadAccountVocabulary(fixtureAccountSource(db))

  const results: { gq: GoldenQuery; outcome: RunOutcome; verdict: Verdict; detail: string }[] = []

  for (const gq of GOLDEN_QUERIES) {
    const outcome = await runQuestion(db, url, model, categories, accounts, gq)
    const { verdict, detail } = judge(gq, outcome, db)
    results.push({ gq, outcome, verdict, detail })

    const mark = verdict === 'pass' ? 'PASS ' : verdict === 'fail' ? 'FAIL ' : 'ERROR'
    console.log(`${mark} ${gq.id}`)
    console.log(`      Q: ${gq.question}`)
    if ('sql' in outcome && outcome.sql) console.log(`      SQL: ${outcome.sql}`)
    console.log(`      ${detail}`)
    console.log('')
  }

  const pass = results.filter((r) => r.verdict === 'pass').length
  const fail = results.filter((r) => r.verdict === 'fail').length
  const error = results.filter((r) => r.verdict === 'error').length

  console.log('─'.repeat(60))
  console.log(`${pass}/${results.length} passed, ${fail} failed, ${error} errored`)
  if (fail > 0 || error > 0) {
    console.log('\nFailures/errors:')
    for (const r of results) {
      if (r.verdict !== 'pass') console.log(`  - ${r.gq.id}: ${r.detail}`)
    }
  }

  process.exit(fail > 0 || error > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
