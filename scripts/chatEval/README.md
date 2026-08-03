# [chat-eval] golden-query eval harness

Answers the question ADR-0006 and the `[chat-eval]` ticket both flag as open:
"is the current chat model good enough at text-to-SQL" — something other than
vibes.

## What it is

- `fixtureDb.ts` — a small, hand-crafted, in-memory ledger (~20 transactions,
  4 accounts) with known contents. Deliberately not `prisma/dev.db`: the eval
  needs exact, reproducible expected answers, and a real ledger changes
  underneath you. "Today" is pinned to `REFERENCE_NOW` (2026-08-03) so
  relative dates ("last month") resolve the same way on every run.
- `goldenQueries.ts` — ~22 natural-language question → expected-result pairs.
  Each expected value is a **ground-truth SQL query** run against the fixture
  DB, not a hand-typed number — auditing one obviously-correct SQL statement
  per fixture is safer than trusting mental arithmetic, and the query doubles
  as the specification of what "correct" means for that question.
- `../evalChatSql.ts` — the runner. Sends each question through the real
  SQL-generation prompt (`lib/chatSqlPrompt.ts`) to a real Ollama server,
  through the real guard chain (every guard function is imported live from
  `lib/`, not reimplemented), executes the resulting SQL against the fixture
  DB, and compares to ground truth.

## Running it

```
npx tsx scripts/evalChatSql.ts [--model=qwen2.5:32b] [--url=http://localhost:11434]
```

(`npm run eval:chat-sql` is wired up too, but `tsx` isn't currently present in
this environment's `node_modules` despite being a listed dependency — the
existing `npm run seed` script has the identical, pre-existing problem. Use
the `npx tsx` form until that's resolved.)

Deliberately **not** a vitest test — it hits a live model over the network,
takes real wall-clock time, and its outcome depends on which model is
configured, none of which belongs in `npm test`. The fixture DB and
ground-truth queries themselves *are* covered by a deterministic vitest test
(`tests/chatEvalFixtures.test.ts`), which protects the specification without
touching Ollama.

## Coverage

Per the ticket: integer cents vs dollars, split-leg double-counting
(`shopping-split-leg`), reimbursement netting (`travel-reimbursement-netting`,
`total-income-reimbursement-aware`), plus general aggregate correctness,
date-window handling, account+category joins, and the refusal paths (balance
questions, unmatched categories, no-data).

## Known limitation

This reimplements `app/api/chat/route.ts`'s guard order as a thin driver — it
calls the same guard functions the route calls, in the same sequence, but is
not the route handler itself. `lib/prisma.ts`'s `DB_PATH` is hardcoded to
`prisma/dev.db`, which this harness must never touch — pointing the real
route at a fixture DB would mean contorting a module AGENTS.md protects as a
safety boundary, which this harness should not risk. If `route.ts`'s guard
order or set ever changes, this file needs a matching update. It will not
drift silently on guard *logic* (that's imported live from `lib/`), only
possibly on guard *order*, or a newly-added guard this file doesn't yet call.

## Baseline run, 2026-08-03 (`qwen2.5:32b`)

**20/22 passed (90.9%).** Two genuine findings, not harness bugs:

1. **`total-income-reimbursement-aware` FAILED** — asked alone ("What was my
   total income last month?"), the model reported $5,300 instead of $5,000: it
   did not apply the reimbursement-settlement exclusion
   (`NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id)`).
   Notably, the *paired* question ("What was my income and my expenses last
   month?") got this right — the shipped worked example teaches the combined
   shape, but there's no worked example for a bare income-only question that
   also needs reimbursement-awareness. Candidate prompt gap, not filed as a
   ticket yet.
2. **`car-loan-payment-transfer-mirror-case` FAILED** — asked "How much did I
   pay on my car loan last month?", the model combined an account filter
   (`Account.name = 'Car Loan'`) with the category filter
   (`category = 'Auto Loan Payment'`) in the same query. In this fixture (and
   in the real app, per ADR-0019) a transfer's category lives on the
   *outgoing* leg only, which is NOT the leg stored against the "Car Loan"
   account — so the two filters intersect to nothing and the query correctly,
   but unhelpfully, returns no-data. Whether this is a model-reasoning gap or
   a fixture question that invites an over-constrained interpretation is a
   genuinely open call — logged here rather than adjusted away.

Neither finding was fixed as part of building this harness — that's a
separate, scoped decision for whoever picks it up next, not something to fold
silently into "build the harness" work.
