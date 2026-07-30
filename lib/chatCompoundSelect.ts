/**
 * Compound-SELECT scope guard for the chat SQL path (ADR-0011).
 *
 * SQLite names a compound result set after its FIRST branch only. Session 11
 * ("If I lose my job, how long could I cover expenses?") generated a `UNION ALL`
 * of two aggregates aliased `total_expenses` and `total_income`, and the rows
 * came back as
 *
 *   [ { "total_expenses": -49818.75 }, { "total_expenses": 50989.23 } ]
 *
 * The income row arrives labelled as expenses. That JSON is exactly what
 * narration is handed, so narration did the right thing under ADR-0007 — it
 * spoke only from its rows — and still produced a self-contradicting answer
 * about money, because the mislabelling happened upstream of anything it can
 * see. The duplicate key is already gone by the time the route holds row
 * objects, so there is nothing downstream to recover the second alias from.
 *
 * Nothing else catches this. The SQL is valid, the read-only guard passes it,
 * execution succeeds, and there is no error for the repair round-trip to act on.
 * It is the ADR-0008 failure shape again: a well-formed query producing a
 * confidently wrong answer, invisible to everything except a human who already
 * knows the numbers.
 *
 * So: **chat-generated SQL may not use `UNION` or `UNION ALL` at all.** A flat
 * ban, not a conditional one. This schema has one fact table, so every
 * multi-metric question here is expressible as conditional aggregates in a
 * single row — which is both the clearer query and the one that keeps its
 * labels. `UNION` buys nothing and is precisely the construct that discards
 * them.
 *
 * Rejecting outright rather than repairing keeps the failure legible: the repair
 * round-trip exists for SQLite errors, there is no error here, and re-prompting
 * on a valid query would just re-roll the dice. Same short-circuit as ADR-0010's
 * alias check and ADR-0015's question-intent check.
 *
 * The check is textual and can over-reject, deliberately (ADR-0011
 * § Consequences). A question whose *text* contains the word "union" is
 * unaffected — this reads generated SQL, never the question — but a legitimate
 * `UNION` need would be declined too. That is an accepted gap: if it ever
 * arises, the fix is a code-computed path, not a carve-out here.
 *
 * Lives here and is called from `app/api/chat/route.ts`, not from
 * `lib/prisma.ts`: the read-only guard stays input-agnostic and single-purpose,
 * and this is a scope check on generated SQL, not a safety check.
 */

/**
 * The compound keyword, word-boundary anchored so a substring can't trip it.
 *
 * `\bUNION\b` matches `UNION`, `union`, `Union` and `UNION ALL`'s first word,
 * but not `union_dues`, `unionized` or `reunion` — in each of those the
 * neighbouring character is itself a word character, so there is no boundary.
 * This schema has no such identifier today; the precision is there so adding
 * one later can't quietly turn every query into a refusal.
 *
 * `ALL` is captured when present purely so the refusal can name what it saw.
 *
 * Scoped to `UNION` only, as ADR-0011 decides. SQLite's other compound
 * operators — `INTERSECT` and `EXCEPT` — share the same first-branch naming rule
 * and would have the same failure mode, but the ADR bans `UNION`/`UNION ALL` and
 * widening a decision record from the implementation ticket is not this file's
 * job. Neither has been observed from the model; if one is, that is an ADR
 * amendment for `@tech-lead`, and this constant is where it lands.
 */
const COMPOUND_RE = /\b(UNION(?:\s+ALL)?)\b/i

/**
 * Single-quoted string literals blanked out, so a category value like
 * `'🍽️ Union Square Diner'` is not read as a compound operator. SQLite escapes
 * a quote by doubling it, which this handles by consuming `''` inside a literal.
 *
 * If the quoting is unbalanced — an odd number of delimiters, i.e. malformed
 * output from the model — stripping would swallow the whole tail of the
 * statement and could hide a real `UNION` behind a stray apostrophe. In that
 * case the caller scans the raw text instead. The safe direction here is to
 * over-reject, never to under-detect.
 */
function stripStringLiterals(sql: string): { stripped: string; balanced: boolean } {
  let out = ''
  let inLiteral = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (!inLiteral) {
      if (ch === "'") { inLiteral = true; out += ' ' } else { out += ch }
      continue
    }
    if (ch === "'") {
      // A doubled quote is an escaped quote, not the end of the literal.
      if (sql[i + 1] === "'") { out += '  '; i++; continue }
      inLiteral = false
    }
    out += ' '
  }
  return { stripped: out, balanced: !inLiteral }
}

export type CompoundSelectViolation = {
  /** The operator as it appeared, normalised to upper case: `UNION ALL`, `UNION`, … */
  keyword: string
}

/**
 * The compound-SELECT violation in the generated SQL, or `null` if there is
 * none.
 *
 * A deliberate regex scan and not a SQL parse, for the same reason as ADR-0008's
 * category check and ADR-0010's alias check: this is a guard on text the model
 * just produced, run before execution, and it only ever decides whether to run
 * the query — it never rewrites it.
 */
export function compoundSelectViolation(sql: string): CompoundSelectViolation | null {
  const { stripped, balanced } = stripStringLiterals(sql)
  const match = COMPOUND_RE.exec(balanced ? stripped : sql)
  if (!match) return null
  return { keyword: match[1].replace(/\s+/g, ' ').toUpperCase() }
}

/**
 * The refusal text.
 *
 * ADR-0014's standard, and ADR-0011's explicit requirement: name the *shape*
 * problem. "I couldn't build a single clear result for that" plus what to do
 * instead. A bare 422 is not an answer. Voice follows `balanceScopeMessage` and
 * `unknownCategoryMessage` — say what was declined, why the number would have
 * been wrong, and what will work.
 */
export function compoundSelectMessage(violation: CompoundSelectViolation): string {
  return (
    `I couldn't build a single clear result for that, so I didn't run anything. The query combined two ` +
    `separate result sets with ${violation.keyword}, and SQLite names a combined result after its first ` +
    `branch only — so every row would have come back under the first column's name. Asking for expenses ` +
    `and income that way returns the income figure labelled as expenses, which is how you get a confident ` +
    `answer that contradicts itself. Try asking for one figure at a time, or ask for the same period and ` +
    `I'll put each figure in its own column.`
  )
}
