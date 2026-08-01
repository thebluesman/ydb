# ADR-0018: Chat SQL is grounded in the stored account-name vocabulary

Status: Accepted
Date: 2026-08-01

## Context

ADR-0008 grounded category filters in the stored `Transaction.category` values and scoped itself out
loud: "Account names have the same shape of problem and are not covered here; if testing surfaced it,
that is a separate ADR." `lib/chatCategoryVocabulary.ts` carried the same reservation in its header.

Testing surfaced it. Session 10 filtered `WHERE a.name LIKE '%credit card%'` against a ledger whose
cards are named after their banks. The query is valid, runs clean, matches nothing, and returns an
empty aggregate — ADR-0008's silent-wrong-answer class arriving through the column ADR-0008 left
uncovered. `@qa` landed it as a failing tripwire in PR #33. Nothing about the mechanism differs; only
the column does.

## Decision

**Account-name filter literals in chat-generated SQL come from the stored vocabulary, on exactly
ADR-0008's mechanism.** The route reads distinct `Account.name` values per request, injects them into
the SQL prompt as a closed list, and refuses with ADR-0014's `out-of-scope` non-answer when a predicate
names an account no stored value can match (`lib/chatAccountVocabulary.ts`). Fresh per turn, no
caching; a cap that escalates rather than truncating; a reserved `__no_matching_account__` sentinel for
"nothing in the list corresponds", per ADR-0008's addendum; similarity used only to fill in "did you
mean", never to pick a filter value.

**This gets its own number rather than an ADR-0008 addendum** for two reasons. ADR-0008 named a
separate ADR as the outcome if this surfaced, so this is the record it predicted. And ADR-0008 already
carries an addendum on a different problem (real-value substitution); folding a second column's scope
decision into it would put two decisions in one ADR. The mechanism is inherited wholesale — this ADR
adds no new stance on grounding-versus-normalising, and ADR-0008's Consequences carry over unread.

**One forced divergence: the qualifier is resolved, not assumed.** `category` is a distinctive column
name, so ADR-0008's scan can look for it directly. `name` is not — `Account.name` and `Category.name`
both exist, and a bare `name` in a joined query is genuinely ambiguous. So the identifiers bound to
`Account` are read off the statement's `FROM`/`JOIN` clauses first, and only predicates on those are
judged. A bare unqualified `name` counts only when `Account` is the statement's sole table.

**That resolution fails open, deliberately.** A table-source shape the scan does not recognise — a CTE,
an unusual join form — is simply not checked; the query runs and a genuine miss still lands on
ADR-0014's `no-data` refusal. This matches ADR-0008's existing failure mode for predicate shapes its
literal extractor does not recognise. Failing closed would refuse ordinary questions on the strength of
a parser gap, and this scan is a regex over model output, not a SQL parser. The cost of failing open
here is bounded by the fact that the uncovered case degrades to the *pre-ADR-0008* behaviour rather
than to a new one.

## Consequences

**A second data-dependent block in the SQL prompt.** ADR-0008 already made this prompt non-static and
justified it — account names, like category names, tell the model what values a column can hold, which
is what the rest of the prompt does. The `num_ctx` open question in `docs/architecture.md` gets more
urgent, not differently shaped; the measured figures there already included both blocks.

**One more query per chat turn**, a `findMany` against a local SQLite file on a request budgeting 120
seconds for two model calls.

**Both passes carry the list and both are checked**, same as categories: a repair pass rewriting a join
is exactly where a qualified name predicate gets reworded.

**Inactive accounts stay in the vocabulary.** `isActive: false` means retired, not that the
transactions vanished. Filtering them out would turn a legitimate question about a closed card into a
refusal naming the account as nonexistent — a worse lie than the one this guard prevents.

**A LIKE pattern is judged on its core**, wildcards stripped, against a substring match. That is the
check that catches session 10, and it is the loosest part of this ADR: a short core will match
something. Accepted, because the alternative is refusing every `LIKE`.

**Invariants untouched.** No change to `lib/prisma.ts`, `lib/accounts.ts`, or money representation.
`executeReadonlyQuery` stays input-agnostic; this changes what SQL gets generated, not how it runs.
