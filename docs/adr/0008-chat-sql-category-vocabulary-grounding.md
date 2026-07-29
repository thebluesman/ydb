# ADR-0008: Chat SQL is grounded in the stored category vocabulary

Status: Accepted
Date: 2026-07-29

## Context

Manual testing of the chat feature on 2026-07-29 turned up a silent-wrong-answer class. Asked "How
much did I spend on groceries last month?", the assistant answered that the data "does not include
the specific amount spent on groceries". The query ran, the read-only guard did its job, and the
result was an empty aggregate — because the generated `WHERE category = '...'` literal did not match
any value actually stored.

Nothing in the pipeline knows what categories exist. `SQL_SYSTEM_PROMPT` (`app/api/chat/route.ts`)
lists `Category(id, name, color)` as a schema line and shows a few-shot example filtering on the
literal `'Groceries'`. The model is guessing a string. Case, pluralisation, or a differently-named
category ("Groceries & Household") all produce the same outcome, and the outcome is indistinguishable
from a true zero.

Two things make that worse than an ordinary miss. The repair round-trip does not fire, because there
was no SQLite error — an empty result set is a successful query. And narration is contractually
required to speak only from the rows it is handed (ADR-0007), so the model does the right thing with
bad input and produces a confident, wrong, plausible answer. There is no eval harness on this path
(`docs/architecture.md` § Open questions), so this failure mode is only ever caught by a human who
already knows the answer.

Note that the filter domain is `Transaction.category`, a free-text column, not `Category.name`. The
two can diverge; the column the SQL filters on is the one that matters.

## Decision

**Category filter values in chat-generated SQL come from the stored vocabulary, not from the model's
guess. The route reads the distinct set of `Transaction.category` values at request time and injects
it into `SQL_SYSTEM_PROMPT` as a closed list, with a rule that a category predicate may only use a
literal from that list. When a question names a category that has no match in the list, the turn
fails loudly rather than returning an empty aggregate.**

Grounding beats normalising. A fuzzy matcher (lowercase, singularise, edit distance) is a retrieval
layer with the same problem ADR-0007 rejected keyword selection for: no harness, no way to show it
picks correctly, and a new silent-wrongness mode when it maps "groceries" onto "Grocery Delivery
Tips". Handing the model the real vocabulary is deterministic and needs no tuning.

The unmatched case is the load-bearing half. "I don't have a category matching X" — with the closest
stored names offered — is a correct answer; "you spent nothing" is not. Whether the failure surfaces
as the existing 422 shape or as a narrated non-answer is `@backend-engineer`'s call, but it must not
reach the user as a zero.

Scope: this ADR governs the category vocabulary only. Account names have the same shape of problem
and are not covered here; if testing surfaces it, that is a separate ADR.

## Consequences

**The SQL prompt grows by a data-dependent block, and the SQL call is no longer purely static.** That
is a real change to a prompt that ADR-0007 deliberately kept lean, and it is justified on different
grounds: category names are schema, not vocabulary. They tell the model what values a column can hold,
which is exactly what the rest of `SQL_SYSTEM_PROMPT` already does. ADR-0007's objection was to prose
that maps to no column. This does not contradict it.

The block is also unbounded in principle. For a single-user ledger the list is short, but
implementation should cap it and, on exceeding the cap, escalate rather than truncate silently — a
partial vocabulary reintroduces the exact bug. The SQL call currently sets no `num_ctx`; adding
tokens here makes resolving that (already an open question in `docs/architecture.md`) more urgent.

**Both passes must carry the list.** The repair round-trip re-sends `SQL_SYSTEM_PROMPT`, so it gets
the vocabulary for free. Keep it that way; a repair pass that loses the grounding can reintroduce a
guessed literal.

**One extra query per chat turn.** A `SELECT DISTINCT` against a local SQLite file, on a request that
already budgets 120 seconds for two model calls. Read it fresh per turn rather than caching, for the
same reason ADR-0007 declined to cache snippets: staleness here is a wrong answer, and a category
added five minutes ago is precisely the one being asked about.

**Invariants untouched.** No change to `lib/prisma.ts`. `executeReadonlyQuery` stays input-agnostic
and keeps its two call sites; this changes what SQL gets generated, not how it is executed or
guarded. Integer-cents money and the `lib/accounts.ts` sign rules (`AGENTS.md` § Canonical decisions)
are not involved.

**Implementation is a separate ticket.** This ADR is a decision record and deliberately contains no
code. `@backend-engineer` owns the build; `@qa` should cover the unmatched-category path explicitly,
since the regression it guards against looks like a correct answer.

## Addendum (2026-07-29): real-category substitution

Live testing of PR #29 before merge, on this ADR's own implementation, found a variant the guard as
first shipped did not catch. Asked "What was spent on Sports in July" (not a stored category), the
model answered a confident 7,372.68 AED, generated against `category = 'Uncategorized'` — a real,
grounded value. The guard checks groundedness (is the literal in the stored list), not correctness
(does it correspond to what the user actually named), and `'Uncategorized'` passes groundedness. Same
silent-wrong-answer class this ADR exists to kill, one level deeper: the model substituted a genuine
value instead of inventing a fake one.

Root cause was a contradiction the original prompt left the model to resolve unaided: "a literal MUST
be copied exactly from the list" versus "don't substitute a near-miss", with no legal move defined for
"nothing in the list corresponds at all". `'Uncategorized'` reads, to a model, as the safe way out of
that bind — real, and plausible-sounding as a home for spending it can't otherwise classify.

The fix stays prompt-level and does not touch the guard's decision logic: a reserved,
vocabulary-external sentinel (`NO_MATCH_SENTINEL`, `__no_matching_category__` in
`lib/chatCategoryVocabulary.ts`) is now the prescribed literal for "nothing corresponds", backed by a
worked few-shot example and an explicit prohibition on substituting a catch-all bucket. The existing
groundedness check already rejects the sentinel — it is not a real stored value — so no new detection
logic was added. Deliberately not pursued: scoring lexical similarity between the question and the
literal in the accept/reject path itself, which would be this ADR's rejected fuzzy-matching failure
mode relocated from "picking an answer" to "vetoing one", with the same false-positive risk (a
legitimately reworded question with no shared substring, refused for the wrong reason).

Verified against live Ollama (qwen2.5:32b) with the real dev-DB vocabulary (46 categories, including a
genuine `Uncategorized`): pre-fix, the Sports question generated `category = 'Uncategorized'`;
post-fix, the identical question against the identical vocabulary generated the sentinel and was
correctly refused. Two further live checks — an unmatched case ("Golf lessons") and two genuine
matches ("Groceries", "Travel") — confirmed the fix doesn't touch the passing path.
