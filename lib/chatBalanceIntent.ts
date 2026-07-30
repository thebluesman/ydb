/**
 * Balance-intent check on the user's *question* (ADR-0015).
 *
 * Scope is unchanged and now three ADRs old: balance, net worth and amounts
 * outstanding are not answerable by chat-generated SQL (ADR-0009, ADR-0010).
 * What ADR-0015 moves is *when* the refusal happens — before any SQL exists.
 *
 * ADR-0010 put the check on the generated SQL's result alias, on the premise
 * that narration "receives `JSON.stringify(rows)` and nothing else", so the
 * column name is the only thing telling it what a number means. That premise is
 * false. Narration also receives the question — it has to, to answer
 * conversationally. Shyam asked "What's the balance on my car loan?", the model
 * produced a bare `SUM(amount) AS net`, and narration said "The balance on your
 * car loan is AED 7034.04". The alias contributed nothing to that sentence; the
 * question did. And widening the alias vocabulary can't close it: the
 * complement of a short blocklist is unbounded (`net`, `flow`, `sum`, `delta`,
 * `movement`).
 *
 * So the question is checked instead. It is the one input that is not model
 * output, it is available before a token is spent, and it is the actual cause of
 * the misframing. On a match the route returns ADR-0014's `out-of-scope`
 * non-answer with no `sql` field at all — nothing was generated, so there is no
 * work to show.
 *
 * `lib/chatBalanceScope.ts` (ADR-0010's alias and `openingBalance` checks) stays
 * exactly as it is, demoted from the mechanism to a second net: it still catches
 * the model reaching for balance arithmetic on a question that named no stock
 * noun ("how much is on my car loan"), which this check misses.
 *
 * Deliberately NOT a narration-prompt rule: telling narration "never call a
 * figure a balance" is one more instruction to the same model that already
 * ignored `SQL_SYSTEM_PROMPT`'s "`SUM(amount)` is never a balance" — and if it
 * worked, the result is the same wrong number with the framing filed off. If a
 * question is a balance question, the answer is a refusal.
 *
 * Per ADR-0015, this is the last cheap proxy available. If it needs an
 * exception, the fix is not a fourth heuristic but the `computeBalance`-backed
 * `get_balances` tool (ADR-0013 Phase C).
 */

import { BALANCE_SCOPE_ALTERNATIVE, BALANCE_SCOPE_PARAGRAPH } from './chatBalanceScope'

/**
 * Nouns and phrases that can only denote a stock, never a flow (ADR-0015 §
 * Decision). Multi-word entries match as contiguous word tokens.
 *
 * `payoff` is the noun only. "How much did I pay off my car loan last month" is
 * a legitimate flow question, and it tokenizes to `pay` then `off` — two tokens,
 * so it cannot match the single token `payoff`. Same for "paid off". This is the
 * known trap ADR-0015 calls out; the regression test for it lives in
 * tests/chatBalanceIntent.test.ts and tests/chatBalanceScopeRoute.test.ts.
 */
export const BALANCE_INTENT_PHRASES = [
  'balance',
  'net worth',
  'owe',
  'owed',
  'owing',
  'outstanding',
  'debt',
  'principal',
  'payoff',
  'how much is left on',
  'how much do i have in',
] as const

/**
 * The question split into word tokens, original case preserved so a match can
 * quote the user's own wording back.
 *
 * Same shape of tokenizing and whole-word matching as the alias check in
 * `lib/chatBalanceScope.ts`, kept local because that module's is private to it
 * and the two operate on different text (a SQL identifier vs. a sentence).
 * Splitting camelCase is harmless here and keeps the two consistent.
 */
function questionTokens(question: string): string[] {
  return question
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

/** A token matches a vocabulary word exactly, or as its plural. */
function tokenMatches(token: string, word: string): boolean {
  const t = token.toLowerCase()
  return t === word || t === `${word}s`
}

export type BalanceIntentMatch = {
  /** The vocabulary entry that fired. */
  phrase: string
  /** The user's own words that matched it, for the refusal message. */
  matched: string
}

/**
 * The first stock-not-flow phrase in the question, or `null` if the question is
 * about flows and generation can proceed.
 *
 * Only ever called with the current turn's question. Conversation history is
 * deliberately not checked: a balance question three turns ago must not poison
 * a later, legitimate flow question.
 */
export function balanceIntentMatch(question: string): BalanceIntentMatch | null {
  const tokens = questionTokens(question)

  for (const phrase of BALANCE_INTENT_PHRASES) {
    const wanted = phrase.split(' ')
    for (let i = 0; i + wanted.length <= tokens.length; i++) {
      if (wanted.every((w, j) => tokenMatches(tokens[i + j], w))) {
        return { phrase, matched: tokens.slice(i, i + wanted.length).join(' ') }
      }
    }
  }
  return null
}

/**
 * The refusal text (ADR-0014's standard: say what was declined, why the number
 * would have been wrong, and where the real figure lives).
 *
 * The scope and alternative paragraphs are the same prose as
 * `balanceScopeMessage` — one scope decision should read identically whichever
 * net catches it. Only the detail sentence differs: it names the wording that
 * triggered the decline, because there is no SQL and no alias to point at.
 */
export function balanceIntentMessage(match: BalanceIntentMatch): string {
  const detail =
    `"${match.matched}" is asking for a balance — an amount outstanding at a point in time — so I ` +
    `stopped before writing a query rather than answering with a figure that would have been a net ` +
    `flow wearing the word "balance".`

  return `${detail} ${BALANCE_SCOPE_PARAGRAPH} ${BALANCE_SCOPE_ALTERNATIVE}`
}
