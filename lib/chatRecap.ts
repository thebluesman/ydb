/**
 * Narrative period summaries (`[chat-model]` Tier 1 output 13).
 *
 * "Give me a monthly recap", "summarize my spending this quarter" want a
 * paragraph that frames a period, not the one-sentence figure the narration
 * prompt otherwise asks for. `docs/architecture.md` records this as a
 * narration-prompt variant needing no wire change — it is prose in the existing
 * `token` stream.
 *
 * Whether a question is recap-shaped is decided HERE, not by the model, for
 * exactly `lib/chatHedge.ts`'s reason: a standing "write a longer summary when
 * appropriate" instruction produces longer summaries for everything, and a
 * three-paragraph reflection on a single number is worse than a flat sentence.
 * So the system prompt carries a two-branch standing rule (RECAP_RULE in
 * lib/chatKnowledge.ts) and this module decides which branch the turn is in.
 *
 * The constraint `docs/architecture.md` states outright: **a recap is not a
 * licence to raise `NARRATION_ROW_CAP`.** A recap wants grouped aggregates —
 * by month, by category — which is a SQL-shape question, answered by the
 * nudge in lib/chatSqlPrompt.ts, not a narration-length one. Feeding the
 * narrator more raw transaction rows to pad the paragraph would undo
 * ADR-0023's one-row-set-one-cap property and cost tokens for a worse answer.
 * Nothing in this file touches the cap or the rows.
 *
 * Wording only. It gates nothing, changes no frame, and alters no number.
 */

/**
 * Verbs and nouns that ask for a summary of a period rather than a figure.
 *
 * Deliberately narrow. "How much did I spend last month" is a period question
 * too, and it must NOT match: it names one figure and wants one sentence. The
 * trigger is the recap framing, not the presence of a period.
 */
const RECAP_INTENT_RE =
  /\b(recap|summar(?:y|ise|ize|ised|ized)|overview|round[-\s]?up|breakdown of my (?:month|quarter|year)|how did (?:my|the) (?:month|quarter|year) go|walk me through|tell me about my)\b/i

/**
 * A period the recap would be framed around. A summary request with no period
 * at all ("summarize my spending") still reads as a recap — the SQL decides the
 * window — so this is not required, only recorded.
 */
const PERIOD_RE =
  /\b(month|quarter|year|week|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4})\b/i

/**
 * Whether this turn's question reads as a request for a period recap.
 *
 * Current turn only, never the history — same rule as `balanceIntentMatch`.
 * A recap asked three turns ago must not turn a later "how much did I spend on
 * coffee" into an essay.
 */
export function isRecapQuestion(question: string): boolean {
  return RECAP_INTENT_RE.test(question)
}

/** True when the recap names a period to frame the paragraph around. */
export function recapNamesPeriod(question: string): boolean {
  return PERIOD_RE.test(question)
}

/**
 * The block appended to the narration prompt on a recap turn, or '' otherwise —
 * in which case nothing is appended and RECAP_RULE's second branch (answer in
 * one or two sentences) applies unchanged.
 *
 * Placed by the route AFTER the closing data marker, never inside it, for the
 * reason `hedgeInstruction` is: everything between the markers is declared
 * verbatim query data that must not be read as instruction, and an instruction
 * smuggled in there would undercut exactly that claim.
 *
 * Every sentence of it is a bound, not an invitation. The failure mode of this
 * feature is a model that, told to write more, writes more than the rows
 * support — so the constraint on inventing detail is stated twice and the
 * length is capped explicitly rather than left to taste.
 */
export function recapInstruction(question: string): string {
  if (!isRecapQuestion(question)) return ''
  return (
    `\n\nThis question asks for a recap of a period rather than a single figure. Write a short ` +
    `paragraph — three to five sentences, no headings, no bullet list — that frames the period as a ` +
    `whole: lead with the largest figures in the data above, then say how they sit against each ` +
    `other. Name the period explicitly if the data identifies it. Every number and every category ` +
    `you mention must come from the rows above; do not estimate a figure that is not there, do not ` +
    `describe a trend the rows do not show, and do not compare against a period you were not given. ` +
    `If the rows are a single aggregate with nothing to break down, say so plainly in one sentence ` +
    `instead of padding.`
  )
}
