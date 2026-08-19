/**
 * Planning-intent check on the user's *question* (ADR-0029).
 *
 * Same mechanism as `lib/chatBalanceIntent.ts` (ADR-0015), applied to a second
 * scope class: questions asking what to do next — a budget target, a savings
 * goal, a forecast — rather than what happened. The ledger stores recorded
 * transactions only; there is no budget table, no goal construct, no
 * forecasting model, so there is no rewrite of the SQL that answers either
 * question. Refusing on the question, before any SQL exists, is the same
 * argument ADR-0015 already made: the question is the one input that is not
 * model output, and the intent is stated plainly in it.
 *
 * ADR-0029's motivating case: "Am I on track to hit my savings goal?" produced
 * a real, plausible-looking two-column CASE aggregate filtered on
 * `category = 'YNAB'` — ADR-0008's grounding passed it because the category is
 * a genuine stored value on one transaction, and the verifier called it
 * `mismatch` rather than `out-of-scope`. This check exists so the question
 * never reaches SQL generation at all.
 */

/**
 * Phrases that can only denote a forward-looking plan, target or prediction
 * (ADR-0029 § Decision). Multi-word entries match as contiguous word tokens.
 *
 * "Should" alone is too broad ("what should I call this category") to include
 * bare; the vocabulary only lists phrases where the forward-looking sense is
 * unambiguous.
 */
export const PLANNING_INTENT_PHRASES = [
  'budget for',
  'should i budget',
  'savings goal',
  'goal',
  'on track',
  'afford',
  'can i afford',
  'forecast',
  'predict',
  'projected',
  'how much should i',
  'will i have',
] as const

/**
 * Same tokenizer as `lib/chatBalanceIntent.ts`, kept local for the same
 * reason: it operates on a sentence, not a SQL identifier.
 */
function questionTokens(question: string): string[] {
  return question
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

function tokenMatches(token: string, word: string): boolean {
  const t = token.toLowerCase()
  return t === word || t === `${word}s`
}

export type PlanningIntentMatch = {
  /** The vocabulary entry that fired. */
  phrase: string
  /** The user's own words that matched it, for the refusal message. */
  matched: string
}

/**
 * The first planning phrase in the question, or `null` if the question asks
 * about what happened and generation can proceed.
 *
 * Current turn only, never conversation history — same discipline as
 * `balanceIntentMatch`, so a planning question three turns ago cannot poison a
 * later, legitimate historical question.
 */
export function planningIntentMatch(question: string): PlanningIntentMatch | null {
  const tokens = questionTokens(question)

  for (const phrase of PLANNING_INTENT_PHRASES) {
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
 * The refusal text: a scope decline, not a "not built yet" decline (ADR-0029
 * § Decision) — names what the ledger holds instead of implying the feature
 * is coming.
 */
export function planningIntentMessage(match: PlanningIntentMatch): string {
  return (
    `"${match.matched}" is asking about a plan, target or prediction, so I stopped before writing ` +
    `a query rather than answering with a figure computed from past transactions dressed up as a ` +
    `plan. This ledger stores recorded transactions — it has no budget targets, savings goals, or ` +
    `forecasting model, so there's no query that would honestly answer this.`
  )
}
