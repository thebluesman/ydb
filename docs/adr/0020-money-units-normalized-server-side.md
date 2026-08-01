# ADR-0020: Money units are normalized server-side, not inferred by the narrator

Status: Accepted
Date: 2026-08-01

## Context

Narration is told money in the data "may already be dollars (from `SUM(amount)/100.0`) or raw cents
(from raw amount columns) — infer from context" (`lib/chatKnowledge.ts:182`). The SQL prompt's only
units rule is scoped to aggregates — "For user-facing sums, divide by 100.0"
(`lib/chatSqlPrompt.ts:196`) — and all nine worked examples are aggregates, so nothing governs a
row-level projection. Nothing runs between execution and narration on units: the route
(`app/api/chat/route.ts:589-636`) checks balance-scope row keys, no-data, and a row cap, then
serializes rows to JSON.

Two shapes reach narration as raw integer cents today, both legitimate:

1. Row-level `Transaction.amount` — "show me my 5 biggest expenses" → `SELECT date, description,
   amount …`, or a bare `SELECT * FROM "Transaction" …`. The star form is explicitly sanctioned;
   ADR-0017 declined to ban it because "show me my recent transactions" is a fine star projection over
   a table with no sensitive column.
2. `Account.creditLimit` (`prisma/schema.prisma:20`, integer cents) — present in the schema block the
   model sees, touched by no guard.

"Infer from context" is not a mechanism. £5,000 and 5,000 cents are both plausible for a single
transaction, and the narrator gets one number and a key name. This is the ADR-0010/0011 failure mode
again — narration reading a claim it cannot check — one column-type layer down.

Result-key inference, ADR-0017's enforcement point, cannot solve it. Keys are model-authored aliases,
and a star projection's engine-resolved `amount` (raw cents) is byte-identical to
`SUM(amount)/100.0 AS amount` (already divided). Same key, opposite meaning.

## Decision

**Units are decided by the server, on the result values, before narration. The narration prompt states
that all monetary values are already in currency units, with no inference clause.**

A route-level classifier walks the *final* `SELECT`'s projection list and resolves each item against
the schema's known money columns (`Transaction.amount`, `Account.creditLimit`, and the two banned
balance columns). Per item:

- Resolves to a money column — bare, qualified, star-expanded over a single known base table, or
  wrapped in unit-preserving arithmetic — and the item contains **no division by 100**: raw cents.
  The server divides the value in the row set.
- Contains a division by 100 anywhere in the item: already converted. Left untouched.
- `COUNT(...)`, or no money column referenced: not money. Left untouched.
- **Not resolvable to base-table columns** — a CTE, a star over a CTE or a multi-table join, a
  subquery in the projection: refused as ADR-0014 `unsupported-shape`, not narrated.

The SQL prompt's `/100.0` rule stays exactly as written. Converted and unconverted projections both
land in currency units, so the two paths converge and the prompt needs no new absolute rule.

**This is not the input-side analysis ADR-0010 abandoned and ADR-0017 declined to revisit.** ADR-0009
failed because *balance-ness is a property of intent*, which is not in the SQL — ADR-0015 had to move
that check onto the question. **Units are a static type property of named schema columns.** The
server owns the schema; `Transaction.amount` is cents in every query ever written. Reading a column
type off a projection is not inferring what a query meant. The line ADR-0016 draws — detectors only
where applicability is decidable from the SQL alone — is satisfied here more cleanly than for either
transfer guard.

**Rejected: option 4, a stronger prompt rule plus a definite narration instruction.** It is the
cheapest change and it would probably work most of the time, which is the problem: it relocates a
wrong-number risk onto model compliance, and this ticket exists because that arrangement already
failed. The prompt-only guards (ADR-0008, 0016, 0019) are prompt-only because their applicability
genuinely isn't decidable. This one is.

## Consequences

**A second guard now runs after execution, and ADR-0017 said the first should stay singular.** Noted
and accepted with the distinction ADR-0017 itself implies: this one *decides* pre-execution, off the
SQL, and only *applies* post-execution, to values. It is not a second post-execution judgement. It
does mean the route's post-execution stage is now a real stage, and ADR-0017's "reconsider the phase
ordering" trigger should be treated as fired for the agentic-loop design (ADR-0012), where this
becomes a property of the `run_sql` tool's return value rather than a route step.

**Refusing unresolvable projections is a real over-rejection, chosen deliberately over failing open.**
ADR-0018 fails open because a missed name check risks a wrong filter that other nets catch. Here,
failing open under a *definite* narration prompt actively manufactures a confident wrong number — the
exact failure being fixed. CTEs are allowed by the prompt but demonstrated by none of its nine
examples, so the expected refusal rate is near zero; if refusals show up in practice, that is the
signal to extend the classifier, not to fail open.

**`SELECT *` on `Transaction` stays legal**, which ADR-0017 went out of its way to preserve. Its
`amount` is now converted rather than guessed at.

**Integer-cents storage is untouched.** Conversion happens on the serialized copy handed to narration.
`lib/accounts.ts`, `lib/prisma.ts` and the read-only boundary are unchanged; this is a presentation
guard, not a safety guard.

**The narration prompt's inference clause is deleted, not softened.** Its comment in
`lib/chatKnowledge.ts` names this ticket as its owner.
