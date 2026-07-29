/**
 * The `no-answer` chat response (ADR-0014).
 *
 * Chat used to have exactly two outcomes: a streamed narration, or an HTTP
 * error. An honest "I can't answer that" had to borrow the crash pathway and
 * read to the user as a broken app. Worse, the most common non-answer — a
 * query that runs cleanly and returns `[{"total": null}]` — never reached the
 * error path at all and got narrated as a confident zero.
 *
 * So declining is now its own wire frame, streamed on a 200 like any other
 * frame. Only transport and unexpected faults stay HTTP errors.
 *
 * Adding a reason is a one-line change here plus one entry in
 * NON_ANSWER_HEADLINE; nothing else on either side switches on the set.
 */

export const NON_ANSWER_REASONS = [
  /** Not answerable from the ledger, or declined by policy (ADR-0010). */
  'out-of-scope',
  /** The query ran and matched nothing. Explicitly NOT narrated as zero. */
  'no-data',
  /** The result can't be trusted to mean what it claims (ADR-0010, ADR-0011). */
  'unsupported-shape',
  /** ADR-0012's loop ran out of iterations or rows. Not yet emitted. */
  'budget-exhausted',
] as const

export type NonAnswerReason = (typeof NON_ANSWER_REASONS)[number]

/**
 * A streamed `no-answer` frame. `message` is written by the route, never by
 * the model — a decline the model phrases is a decline the model can talk
 * itself out of. `sql` is the attempted query, same field as the `type: 'sql'`
 * frame: a non-answer must show its work (ADR-0014).
 */
export type NonAnswerFrame = {
  type: 'no-answer'
  reason: NonAnswerReason
  message: string
  sql?: string
}

/** Short label shown beside the message, so refusals are distinguishable at a glance. */
export const NON_ANSWER_HEADLINE: Record<NonAnswerReason, string> = {
  'out-of-scope': 'Out of scope',
  'no-data': 'No matching data',
  'unsupported-shape': 'Result not trustworthy',
  'budget-exhausted': 'Gave up before a confident answer',
}

export function isNonAnswerReason(value: unknown): value is NonAnswerReason {
  return typeof value === 'string' && (NON_ANSWER_REASONS as readonly string[]).includes(value)
}

export function nonAnswerFrame(
  reason: NonAnswerReason,
  message: string,
  sql?: string,
): NonAnswerFrame {
  return sql === undefined ? { type: 'no-answer', reason, message } : { type: 'no-answer', reason, message, sql }
}

/**
 * A `no-answer` sent on its own, without a narration stream behind it. Served
 * as single-line NDJSON on a 200 so the client's existing frame reader handles
 * it with no special-casing — a refusal is a successful response.
 */
export function nonAnswerResponse(frame: NonAnswerFrame): Response {
  return new Response(JSON.stringify(frame) + '\n', {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

/**
 * Whether a result set carries no answer at all.
 *
 * Two cases, and the second is the one that matters: zero rows, or rows whose
 * every column is NULL. `SELECT SUM(amount) ... WHERE category = 'Grocries'`
 * returns one row of `{ total: null }` — a miss, not a zero. A genuine
 * `COUNT(*)` of 0 is a real answer and is deliberately NOT caught here: only
 * NULL means "nothing matched".
 */
export function isNoDataResult(rows: unknown[]): boolean {
  if (rows.length === 0) return true
  return rows.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      Object.values(row as Record<string, unknown>).every((v) => v === null),
  )
}

/**
 * The `no-data` message. Says what was tried and what would help, rather than
 * "I couldn't answer that" — ADR-0014's standard. The concrete "your
 * categories are: …" follow-up belongs to ADR-0008's vocabulary grounding and
 * is deliberately not built here.
 */
export function noDataMessage(question: string): string {
  return (
    `I ran a query for "${question.trim().slice(0, 200)}" and it matched no transactions, ` +
    `so I don't have an answer — this is not the same as a total of zero. ` +
    `The usual cause is a filter that doesn't match what's stored: a category or account name ` +
    `spelled differently, a date range with nothing in it, or a status filter excluding the rows. ` +
    `The query I tried is below.`
  )
}
