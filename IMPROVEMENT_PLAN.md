# ydb — Code & Product Review + Improvement Plan

**Audience:** an implementing agent/developer picking this up cold. Every task lists the files to touch,
what to change, and how to verify it. Work top-to-bottom: phases are ordered by impact-per-effort,
and later phases assume earlier ones are done.

**Context:** ydb is a local-first personal finance tracker (Next.js 16 / React 19, SQLite via
Prisma 7 + better-sqlite3, Ollama for statement extraction and Text-to-SQL chat). Single user,
home LAN, no auth by design. The stated pain point is **severe performance issues**. This review
found the causes are architectural, not mysterious: full-table reads on every page view, all
filtering/aggregation done in JS instead of SQL, an un-tuned SQLite connection, and (very likely)
the app being run with `next dev` instead of a production build.

> ⚠️ Before writing any code, read the relevant guide in `node_modules/next/dist/docs/` —
> this Next.js version has breaking changes vs. what you may expect (see `AGENTS.md`).
> Run `npm install` first if `node_modules` is missing.

---

## 0.5 baseline measurements (M1 exit checkpoint)

Measured 2026-07-16, on the actual home-server machine (this laptop), after 0.2 (WAL/pragmas)
and 0.3 (prod build) landed, via `npm run build && npm run start` on port 3333, then:
`curl -so /dev/null -w '%{time_starttransfer}s %{size_download}B\n' http://localhost:3333/<route>`.
Three data points, measured in sequence against the same code:

| Data state | Route | Cold | Warm | Size |
|---|---|---|---|---|
| Empty DB (0 tx, 0 accounts) | `/ledger` | 0.018s | 0.001s | 22.5KB |
| Empty DB (0 tx, 0 accounts) | `/dashboard` | 0.124s | 0.007s | 32.2KB |
| Real data, restored from `backups/ydb-2026-05-20_06-59-04.db` (119 tx, 8 accounts) | `/ledger` | 0.018s | 0.001s | 22.5KB |
| Real data (119 tx, 8 accounts) | `/dashboard` | 0.130s | 0.010s | 55.0KB |
| Synthetic seed on top of real accounts (50,119 tx, 8 accounts) | `/ledger` | 0.016s | 0.002s | 22.5KB |
| Synthetic seed (50,119 tx, 8 accounts) | `/dashboard` | **0.488s** | **0.302s** | 58.5KB |

**Reading this:**
- `dev.db` was empty going into this session because the real data was intentionally cleared
  pending this rework; a real 119-row backup existed at `backups/ydb-2026-05-20_06-59-04.db`
  (two more recent backups, `05-28` and today's, are also empty).
- `/ledger`'s response size and latency **don't move at all** across 0 → 119 → 50k rows — its
  route only serves the client shell; the actual transaction data is fetched client-side after
  hydration, so this curl-based test doesn't exercise the ledger's real cost at all. That in
  itself confirms the plan's Phase 1 diagnosis (full client-side fetch/filter) rather than
  refuting it — a proper ledger measurement needs to time the client-side data fetch, not the
  initial HTML.
- `/dashboard` **is** SSR'd and shows the predicted degradation directly: 10ms warm at 119 rows →
  302ms warm at 50k rows, a ~30x regression from a 420x increase in row count. This confirms
  root cause #2 (dashboard aggregates in JS across every committed transaction) and is a real
  signal, not a synthetic-data artifact — accounts were real, only the transaction rows were
  generated.
- `dev.db` was restored to its pre-session empty state after this test (your call — you're
  holding off on re-entering real data until further into the rework). The 119-row real backup is
  untouched at its original path.
- **Conclusion for M2 sequencing:** this settles it — M2b (server-driven ledger) and Phase 2
  (SQL dashboard aggregation) stay high-priority and go before U-phase-only work; the dashboard
  number alone shows the full-table-JS-aggregation problem is real and already significant at
  50k rows, which is a plausible multi-year size for a single-user tracker.

---

## 1. Review summary

### What is good (do not break)

- **Integer-cents money model** (`lib/money.ts`, comments in `prisma/schema.prisma`) with
  conversion only at boundaries. Keep this invariant everywhere.
- **Sign/type conventions** centralized in `lib/accounts.ts` and enforced by
  `lib/transactionValidation.ts` on all write paths.
- **Read-only SQLite connection + identifier guard** for LLM-generated SQL (`lib/prisma.ts`).
  The driver-level `readonly: true` is the real safety boundary; keep it.
- Transfer linking, splits, and reimbursement netting have consistent hidden-row rules mirrored
  across dashboard, ledger, and the chat SQL prompt.
- CSV export escapes formula injection; PDF text extraction reconstructs lines by y-coordinate;
  LLM output has a salvage parser; daily auto-backup via `instrumentation.ts`.
- Unit tests exist for money, accounts, validation, and the SQL guard.

### Root causes of the performance problem (ranked)

| # | Cause | Where |
|---|-------|-------|
| 1 | Ledger page loads **every transaction in the DB** with 5 relation includes into the RSC payload, then filters/sorts/paginates client-side | `app/ledger/page.tsx`, `app/ledger/_components/LedgerView.tsx` |
| 2 | Dashboard loads **every committed transaction ever** (no date bound) plus an account include, then does ~6 full in-memory passes | `app/dashboard/page.tsx:82-89` |
| 3 | Likely running `next dev` on the server (README only documents `npm run dev`); dev mode compiles on demand and runs React in dev mode — this alone can explain "severe" slowness | `README.md`, deployment |
| 4 | SQLite is un-tuned: no WAL, no busy_timeout on the write connection; writers block readers | `lib/prisma.ts:8-11` |
| 5 | Settings page and `GET /api/vendor-rules` fetch **5,000 transactions** and run every rule against all of them in JS on every load | `app/settings/page.tsx`, `app/api/vendor-rules/route.ts` |
| 6 | Chat page refetches the session list **on every streamed token batch** (`onMessagesChange` fires from a `useEffect` on `messages`) | `app/chat/page.tsx:88-95`, `app/chat/_components/ChatPane.tsx:45-48` |
| 7 | `GET /api/transactions` is a full-table dump with includes; used to reload the whole ledger after adding a transfer | `app/api/transactions/route.ts:5-17`, `LedgerView.tsx:299` |
| 8 | `LedgerRow` (917 lines, Radix portals) is not memoized; every search keystroke re-renders all 50 visible rows; search has no debounce | `LedgerView.tsx`, `LedgerRow.tsx` |
| 9 | `check-duplicates` runs up to 100 **sequential** `findMany` queries | `app/api/transactions/check-duplicates/route.ts` |
| 10 | 1,502-line static guide is a `'use client'` component shipped in the JS bundle | `app/guide/_components/GuideView.tsx` |

### Correctness / integrity issues found

- **No Prisma migrations are committed** (`prisma/` contains only `schema.prisma`), yet the README
  says to run `npx prisma migrate dev`. A fresh clone cannot reliably reproduce the schema, and no
  future schema change can be applied safely. Must fix before any schema work.
- **Chat SQL results are unbounded server-side.** The prompt asks the model for `LIMIT 200`, but
  nothing enforces it — `executeReadonlyQuery` materializes every row (`stmt.all()`), and a model
  that omits the LIMIT can pull the entire table into JSON.
- **Ledger stat cards mix currencies.** With "All accounts" selected, income/expenses sum cents
  across accounts of different currencies and label the result with the base currency
  (`LedgerView.tsx:116-148`). The dashboard correctly partitions by currency; the ledger does not.
- **README promises "set your preferred model in Settings"** but both LLM routes read only env vars
  (`OLLAMA_MODEL`, `CHAT_MODEL`, `OLLAMA_URL`); Settings only stores `baseCurrency`.
- **Duplicate check silently caps at 100 candidates** (`check-duplicates/route.ts` `slice(0,100)`);
  a 300-row statement gets rows 101+ unchecked with no warning.
- **`DELETE /api/transactions/[id]` cascades onto the linked transfer counterpart**, even when the
  counterpart was a real imported row (already tracked in `FOLLOWUPS.md` §2).
- **Settings page performs DB writes during render** (category color migration,
  `app/settings/page.tsx` "Migrate any categories" block).
- **Chat history sent to the model grows without bound** (whole session is concatenated into both
  the SQL prompt and the narration prompt).
- No DB-level CHECK constraints or `linkedTransferId` symmetry enforcement (FOLLOWUPS §5) —
  application-level only.
- Ollama calls have **no timeout/AbortSignal server-side**; a hung Ollama leaves requests dangling.

---

## 2. The plan

### Phase 0 — Foundations & quick wins (do first, ~a day)

**0.1 Commit a baseline Prisma migration.**
- Run `npx prisma migrate dev --name baseline` against a scratch DB (or
  `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` to
  generate SQL) and commit `prisma/migrations/`.
- Verify: fresh clone + `npx prisma migrate dev` produces a working `dev.db`.

**0.2 Tune SQLite.**
- In `lib/prisma.ts` `createPrismaClient()`, after constructing the adapter/client, execute pragmas
  on the underlying connection (open a short-lived `better-sqlite3` handle on the same file if the
  adapter doesn't expose one):
  `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`.
- WAL is persistent per-database-file, so setting it once at startup is enough; keep it in startup
  anyway for fresh DBs.
- Verify: `PRAGMA journal_mode;` returns `wal`; concurrent chat query during an import no longer
  errors with SQLITE_BUSY.

**0.3 Document & script production mode.**
- README: replace the "Getting Started" run instructions with
  `npm run build && npm run start` for the home server, keeping `npm run dev` under a
  "Development" heading. Add a sample `systemd` unit (WorkingDirectory, `npm run start`,
  `Restart=on-failure`).
- Verify: `npm run build` completes; app serves on :3333 via `npm run start`.

**0.4 Add missing composite index.**
- `prisma/schema.prisma` Transaction: add `@@index([accountId, status, date])` (dashboard and
  balance queries filter on accountId+status, often with a date bound). Create via a new migration.
- Note: the baseline migration (0.1) must match the **current** schema exactly — it gets marked
  as applied on the live DB via `prisma migrate resolve` without executing. Any schema *change*
  (this index, the Phase 6.2 CHECK constraints) must be a separate follow-on migration so it
  actually runs against the live database. Do not fold schema changes into the baseline.

**0.5 M1 exit checkpoint — re-measure before committing to the rewrites.**
- The "likely running `next dev`" diagnosis (root cause #3) is inferred from the README, not
  confirmed. After 0.2/0.3 are deployed on the real server, measure against the real DB:
  `curl -so /dev/null -w '%{time_starttransfer}s %{size_download}B\n'` for `/ledger` and
  `/dashboard`, plus interaction feel (ledger search typing, page switches).
- Record the numbers at the top of this file. They serve two purposes: (a) if prod mode + WAL
  already made the app feel fine, M2's urgency drops — do M2a (design system) next and let M2b
  ride behind it rather than rushing; (b) they become the baseline that Phase 1/2's "definition
  of done" is judged against on this hardware, instead of the placeholder targets below.
- Phases 1–2 stay on the roadmap regardless: full-table reads scale with the DB and will degrade
  every month — the checkpoint sets pacing, not direction.

### Phase 1 — Ledger: move filtering/pagination to the server (biggest win)

> **Status (M2b): DONE** — server-driven ledger implemented on branch
> `claude/m2b-ledger-server-rewrite`. Query params, DB-computed stats, currency-scope fix,
> CSV export, URL-driven filters, 250ms debounced search, `React.memo` rows, and the
> `pendingReimbursementCount`/outstanding banner are all in place. The shared predicate lives
> in `lib/transactions-query.ts` and is validated against a JS oracle in
> `tests/ledgerStats.oracle.test.ts` (splits, transfers, matched/pending reimbursements,
> multi-currency). **Deferred:** the 50k-row `scripts/seed.ts` + perf-number verification
> (no seed data available this session) — the change is structurally sound (page-only
> serialisation, all filtering/aggregation in SQL), but the <200ms/<100KB guardrails were not
> benchmarked. Track under Phase 8's seed script.
>
> **Resolved in M7a (Phase 8):** `npm run seed` (~48k rows) now exists. `/ledger?pageSize=50`
> measured ~250ms warm / ~320KB against the seeded DB — within the guardrails. See the M7a status
> note under Phase 8 for the full methodology and a real dashboard-side regression the seed data
> also surfaced (fixed there, not here — the ledger's own queries were unaffected).
>
> **Review pass (post-approval, PR #4):** rebased onto `main` after M2a merged (the
> ledger components now use the M2a design-system primitives). Three review notes addressed:
> (1) **Multi-currency "All accounts"** — the row list and CSV are no longer narrowed to
> base-currency accounts; they span every account, while the stat cards stay scoped to the base
> currency (money math needs a single currency) and a caption says so. This removes the old
> silent-hiding and the empty-ledger edge case (≥2 currencies, none matching base).
> (2) **Search escaping** — the row/count/CSV queries now build on the same raw-SQL
> `buildFilterSql` predicate (literal `LIKE … ESCAPE`) as the stats, so `%`/`_` in a search term
> can't make the rows and the stat counts disagree; `buildPrismaWhere` was removed (one predicate).
> (3) **Category filter options** derive from a full-table `SELECT DISTINCT category`, not just the
> current page. Row selection is now covered by `tests/ledgerRows.oracle.test.ts`.

The ledger currently ships the whole table to the client and keeps a mutable copy in React state.
Replace with a server-driven table. Working target: `/ledger` responds in <200 ms and transfers
<100 KB with 50k rows in the DB — these are order-of-magnitude guardrails, **not** benchmarked
against the actual home-server hardware; calibrate them against the 0.5 baseline numbers. The
non-negotiable definition of done is structural: response time and payload size must be
independent of total table size (no full-table reads, no full-table serialization).

**1.1 Query API.**
- Rework `GET /api/transactions` (`app/api/transactions/route.ts`) to accept query params:
  `page` (default 1), `pageSize` (default 50, max 200), `accountId`, `type`, `category`, `status`,
  `search` (matches `description` OR `originalDescription`, case-insensitive `contains`),
  `sort` (`date|amount|description|category|transactionType`), `dir` (`asc|desc`),
  `pendingReimbursements=1` (reimbursableFor set, reimbursementTxId null).
- Always filter `parentTransactionId: null` (legs render under their parent), keep the existing
  5 includes **only for the returned page**.
- Return `{ rows, total, stats }` where `stats` is computed **in the database** over the full
  filtered set (not the page): income/expense sums and counts excluding transfers and matched
  reimbursement pairs. Use `prisma.$queryRaw` with the same exclusion rules as the current
  `stats` memo in `LedgerView.tsx:116-141` (`NOT EXISTS` subquery for the settlement side).
- Keep the CSV export working: accept `format=csv` (or a `limit=all` mode) that streams the full
  filtered set without includes.

**1.2 Page + view.**
- `app/ledger/page.tsx`: read `searchParams`, run the same query server-side for the initial
  render (share a `lib/transactions-query.ts` helper between the page and the API route), pass
  `rows`, `total`, `stats` to `LedgerView`.
- `LedgerView.tsx`: filters/sort/page write to the URL via `router.replace` (shallow) and data
  refetches from the API; drop the `transactions` full-copy state. Debounce the search input
  (250 ms). Keep optimistic row updates (`onUpdate`/`onDelete` patch the current page in place).
- After creating a transfer, refetch **the current page** instead of the whole table
  (`LedgerView.tsx:298-300`).
- Wrap `LedgerRow` in `React.memo`. Pass stable callbacks (wrap handlers in `useCallback` keyed
  by id, or pass id-based handlers as ReviewTable already does).
- The pending-reimbursements banner needs a count without loading all rows: include
  `pendingReimbursementCount` + outstanding sum in the `stats` object.
- Fix the **currency mixing bug**: when `accountFilter === 'all'` and accounts span >1 currency,
  either group the stat cards per currency or scope stats to the base-currency accounts and label
  accordingly. Match the dashboard's behavior.
- Verify: with a seeded 50k-row DB (write a small `scripts/seed.ts`), `/ledger` first paint is
  fast, typing in search does not freeze, pagination/sort round-trips are <100 ms.

### Phase 2 — Dashboard: aggregate in SQL

Rewrite `app/dashboard/page.tsx` data loading. Keep the exact exclusion semantics (split parents
hidden when legs exist; both sides of matched reimbursement pairs hidden; transfers excluded from
income/expense) — they are documented in comments there and mirrored in the chat prompt.

- Replace the all-rows `findMany` (line 82) with grouped raw SQL:
  - monthly income/expenses: `strftime('%Y-%m', date)` GROUP BY with the exclusion predicates
    (`parentTransactionId IS NULL OR` leg-inclusion rule — replicate the "count legs, hide parent"
    rule: a parent is hidden iff it has legs, i.e. `NOT EXISTS(child)`; legs themselves are counted);
  - category breakdown and per-category monthly trend: same predicates, GROUP BY category / month;
  - summary stats derive from the monthly query;
  - pre-range asset seed (lines 202-227): single `SELECT SUM(amount)` with the same predicates and
    `date < startDate`.
- Write the shared predicate once as a SQL fragment in `lib/transactions-query.ts` with a comment
  linking it to the dashboard rules, and reuse it for ledger stats (Phase 1) so the two screens
  can't drift.
- Keep `groupBy` for account balances (already efficient) and the two `take: 20` top-transaction
  queries (fine as-is).
- Add a **unit test** comparing the SQL aggregates against the old in-memory algorithm on a fixture
  set that includes splits, linked reimbursements, and transfers (port the current JS logic into the
  test as the oracle before deleting it).
- Verify: dashboard totals unchanged on the existing DB (snapshot values before/after); render
  time judged against the 0.5 baseline (working guardrail: ~150 ms with the 50k-row seed — same
  caveat as Phase 1: the structural requirement is "no full-table reads", not the exact number).

> **M3 status:** done. `app/dashboard/page.tsx` now loads via grouped raw SQL in
> `lib/transactions-query.ts` (a fresh copy of this file, since M2b's own copy hasn't merged to
> `main` yet as of this branch — reconcile the two when M2b lands). `tests/dashboard.oracle.test.ts`
> ports the old in-memory algorithm as the oracle, covering splits, linked reimbursements,
> transfers, and multi-currency, and passes before the JS aggregation was deleted. Totals were
> spot-checked against the existing dev DB before/after; no seed data was available this session,
> so the 50k-row/150ms guardrail is unbenchmarked (same caveat as Phase 1 — track under Phase 8).
>
> **Resolved in M7a (Phase 8):** benchmarking against the ~48k-row seed found `/dashboard` was NOT
> meeting the guardrail — it took ~52 SECONDS, not ~150ms, due to a query-planner index-selection
> issue in `inclusionSql()`'s correlated subqueries (unrelated to the grouped-aggregation approach
> itself, which is structurally correct). Fixed with `INDEXED BY` hints; re-measured at ~350ms warm.
> Full root-cause and fix details are under Phase 8's M7a status note.

### Phase 3 — API hygiene

**3.1 Chat session refetch storm.** In `app/chat/page.tsx`, `handleMessagesChange` refetches
`/api/chat-sessions` every time `messages` changes — i.e., per streamed chunk. Change `ChatPane` to
call a new `onResponseComplete` callback once, after the stream finishes (and after persistence),
and refresh the sidebar only then. Remove the `onMessagesChange` effect-per-render pattern.

**3.2 Vendor-rule match counts.** `GET /api/vendor-rules` and `app/settings/page.tsx` each pull
5,000 rows and run all rules in JS.
- Split the endpoint: plain `GET /api/vendor-rules` returns rules only (this is what the upload
  flow needs); `GET /api/vendor-rules?withCounts=1` computes counts.
- Compute counts in SQL for the non-regex match types (`LIKE '%pat%'`, `LIKE 'pat%'`,
  `LIKE '%pat'`, `=` — remember to escape `%_` in the pattern) with the direction/amount gates as
  WHERE clauses; keep the JS path only for `regex` rules (they are rare).
- Settings page: fetch counts lazily from the client (the `VendorRuleManager` can show counts after
  mount) so `/settings` renders instantly; also move the category color migration (DB writes during
  render) into a one-off script or the `instrumentation.ts` startup hook.

**3.3 Duplicate check.** Rewrite `check-duplicates/route.ts` to one query: compute the min/max date
across candidates, fetch existing rows for the involved `accountId`s and date window with
`select: {accountId, amount, date, description}`, then match candidates in memory (same similarity
function). Remove the 100-candidate cap, or if kept for safety raise it and return a
`checked: n, skipped: m` field the ReviewTable surfaces.

**3.4 Enforce a row cap on chat SQL.** In `executeReadonlyQuery` (`lib/prisma.ts`), replace
`stmt.all()` with `stmt.iterate()` and stop after e.g. 500 rows (throw or truncate-with-flag).
Return `{ rows, truncated }` and let `app/api/chat/route.ts` mention truncation to the narrator.
Add a test in `tests/sqlGuard.test.ts`.

**3.5 Cap chat history.** In `app/api/chat/route.ts`, take only the last ~8 messages of `history`
for both prompts, and cap each message's length.

**3.6 Ollama resilience.** Both `app/api/ollama/route.ts` and `app/api/chat/route.ts`: add
`AbortSignal.timeout(...)` (e.g. 120 s for generation calls), forward client aborts
(`request.signal`), and set `options: { temperature: 0 }` for the SQL-generation call. Add a tiny
`GET /api/ollama/health` that pings `${OLLAMA_URL}/api/tags` — the UI phases can use it for a clear
"Ollama is not running" state instead of failing mid-flow.

> **M3 status:** done — 3.1 (`onResponseComplete` fires once post-stream in `ChatPane`), 3.2
> (`?withCounts=1` split, SQL counts for non-regex match types in `lib/vendor-rule-match.ts`,
> lazy client fetch in `VendorRuleManager`, category-color migration moved into
> `instrumentation.ts`), 3.3 (`check-duplicates` batched into one date/account-scoped query, cap
> raised with a `checked/skipped` field), 3.4 (`executeReadonlyQuery` now iterates and truncates
> at 500 rows with a `truncated` flag, covered in `tests/sqlGuard.test.ts`), 3.5 (chat history
> capped to the last 8 messages), 3.6 (timeouts, abort forwarding, `temperature: 0` for SQL gen,
> `GET /api/ollama/health`).

### Phase 4 — Client rendering cleanups ✅ (M4)

- **Guide:** ✅ removed `'use client'` from `GuideView.tsx`. The four interactive demo widgets
  (`FormatDemo`, `TransactionRowDemo`, `ChatConversationDemo`, `ReimbursementDemo`) moved to
  `GuideDemos.tsx`; the scrollspy sidebar nav moved to `GuideNav.tsx`. `GuideView.tsx` is now a
  Server Component — confirmed by the build output showing `/guide` as `○ (Static)`.
- **Ledger:** done in Phase 1 (memo + debounce). `alert()`/`confirm()` had already been replaced by
  a `Modal`-based confirm dialog + toast system during M3 (no native dialogs remained by the time
  this phase started). ✅ Added "Undo" to delete: `LedgerRow.tsx` snapshots the deleted row
  (including split legs and transfer counterpart id) before calling `DELETE`, then shows a 5s toast
  with an Undo action that re-POSTs to `/api/transactions/manual` (and replays `/[id]/split` for
  split legs) and triggers a ledger refetch. Recreated rows get new ids — acceptable per the plan's
  own "cheaper than soft-delete, good enough for home use" framing.
- **Chat:** ✅ fixed. `ChatPane.tsx` now checks whether the message thread is scrolled near the
  bottom before auto-scrolling, and uses `behavior: 'auto'` (instant) while a response is streaming,
  `'smooth'` once it's done — eliminates the per-token jitter from `smooth` scrolling on every chunk.
- **Dashboard:** verified — no client-side chart data transform pipeline exists to memoize. Chart
  components (`DashboardView.tsx`, `NetWorthWidget.tsx`, `CategoryTrendChart.tsx`) receive
  pre-aggregated data straight from server props (Phase 2's SQL aggregation) and pass it directly to
  `recharts`. Left as-is per the plan's own "otherwise leave" branch.

### Phase 5 — LLM pipeline quality

- **Settings-driven config (fixes the README lie).** Add Settings keys `ollamaUrl`,
  `extractionModel`, `chatModel`. Both LLM routes read the Setting first, env var as fallback,
  current defaults last. Cache the setting lookup per request only (no global cache — it can go
  stale). **UI: defaults-first, not a raw model dropdown.** A list of installed model names tells
  the user nothing about which is good at extraction vs. text-to-SQL. `PreferencesForm.tsx` shows
  the two roles with their current values and a short recommendation line each; changing them is
  an "Advanced" disclosure with the `${ollamaUrl}/api/tags` list (via a small proxy route), where
  known-good models are annotated ("recommended for SQL", "faster, less accurate") and unknown
  ones are selectable but unannotated. Write the actual recommendations down in the README
  (starting point: `qwen2.5-coder:14b` for extraction — structured-output-focused, fits modest
  VRAM; `qwen2.5:32b` for text-to-SQL if the box has the memory, else the 14b; revise from
  experience). The current env-var defaults stay as the shipped defaults.
- **Structured extraction.** In `app/api/ollama/route.ts` pass Ollama's structured output
  (`format: { type: 'array', items: {...} }` — check the Ollama docs for the JSON-schema `format`
  parameter) so the model must emit valid JSON. **This is unvalidated against the models this app
  actually runs** — local models honor `format` inconsistently. First step of this task: test
  `format` against the configured extraction model with a real statement's text; record the result
  in this file. Keep the salvage parser as a permanent fallback regardless of the outcome (do not
  treat structured output as a reason to delete it). Remove the `'['` assistant-priming hack only
  when `format` is confirmed working for the model in use.
- **Chunk long statements.** In `UploadFlow.tsx`, if extracted text exceeds ~12 KB, send one
  request per page (the page loop already yields per-page text) and concatenate the parsed arrays.
  Show "page 2/5" in the parse log. This keeps well inside `num_ctx` and improves accuracy.
- **SQL retry loop.** In `app/api/chat/route.ts`, when `executeReadonlyQuery` throws a SQLite error,
  send one repair round-trip to the model ("The query failed with: <error>. Return a corrected
  SQLite SELECT.") before surfacing the error. One retry max.

> **M4b status (Phase 5): DONE.** Implemented on `claude/m4b-llm-pipeline`.
>
> 1. **Settings-driven config — done.** `lib/llm-config.ts` `getLlmConfig()` resolves
>    `ollamaUrl`/`extractionModel`/`chatModel` with **Setting → env var → shipped default**
>    precedence, read fresh per request (no module cache, so a Settings change takes effect on the
>    next request). Both routes (`app/api/ollama/route.ts`, `app/api/chat/route.ts`) and
>    `/api/ollama/health` (which doubles as the model-list proxy for `${ollamaUrl}/api/tags`) use
>    it. UI is defaults-first: `app/settings/_components/ModelSettings.tsx` (mounted in
>    `PreferencesForm`) shows each role with its current value + a recommendation line; an
>    **Advanced** disclosure lists installed models annotated via `annotateModel()`
>    (known-good ones labelled, unknown ones selectable-but-unannotated) plus an Ollama-URL field.
>    Client-safe metadata lives in `lib/llm-models.ts` (no prisma import). README `## Models`
>    section documents the recommendations and precedence. Shipped defaults unchanged.
> 2. **Structured extraction — VALIDATED, WORKS.** Tested `format` (JSON-schema `{ type: 'array',
>    items: {...} }`) against the configured/default extraction model **qwen2.5-coder:14b** on the
>    running local Ollama with realistic credit-card statement text. Result: the JSON-schema
>    `format` works **reliably** — output was a complete, valid JSON array (parsed first try, 7/7
>    rows), correct signs (plain→negative, CR→positive), skipped OPENING BALANCE / END OF STATEMENT,
>    and concatenated a multi-line description. Confirmed it also holds under **streaming** and the
>    model **self-starts the `[`**, so the `'['` assistant-priming hack was removed (route no longer
>    sends the priming message; client no longer re-prepends `[`). Note: `format: 'json'` (the bare
>    string form) misbehaved — it returned a single object, not an array — so only the JSON-schema
>    form is used. The brace-walking **salvage parser in `UploadFlow` is kept as a permanent
>    fallback** regardless. Also set `temperature: 0` on the extraction call.
> 3. **Chunk long statements — done, with a documented boundary limitation (PR #7 review).** OCR
>    retains per-page text (`ocrPagesRef`). In `UploadFlow.runParse`, statements over the
>    `CHUNK_THRESHOLD` with >1 page are sent one request per page and the parsed arrays
>    concatenated; the parse log shows "Page 2/5 · N tokens …". Short statements keep the
>    single-request path.
>
>    **Boundary manual test (the unchecked Test Plan item — now actually run).** Built a
>    synthetic-but-realistic 3-page credit-card statement (>12 KB total, so the >12 KB gate opened)
>    with ONE transaction deliberately straddling the page-1/page-2 break: `28 Mar DUBAI DUTY FREE
>    TERMINAL 3 … CONTINUED` ends page 1 (no amount yet), and `PERFUME AND ACCESSORIES DUTY FREE
>    417.00` opens page 2. Drove the real chunked path against the configured extraction model
>    (**qwen2.5-coder:14b** on local Ollama), replicating `/api/ollama` exactly (credit-card system
>    prompt, JSON-schema `format`, `num_ctx: 32768`, `temperature: 0`), concatenating per-page as
>    `runParse` does.
>
>    **Result: the reviewer's concern is real and reproducible.** In every chunked run the straddling
>    transaction was corrupted, while a single-request extraction of the same text got it right:
>    - At ~12.6 KB (chunking active): page 1 **dropped** the first half entirely (incomplete row, no
>      amount); page 2 emitted `{date:"", description:"PERFUME AND ACCESSORIES DUTY FREE",
>      amount:-417}` — **blank date, truncated description** (lost the "DUBAI DUTY FREE TERMINAL 3 …
>      REF 88213" half).
>    - At a smaller size (forced per-page): the SAME transaction became **two** corrupt rows — a
>      phantom `amount: 0` row on page 1 and a mis-dated (`01 Jan`, bled from a neighbour) `-417` row
>      on page 2.
>    - **Control, single request over the whole text:** ONE correct row — full description, correct
>      `2024-03-28` date, `-417`. So the single-request path is boundary-safe; per-page chunking is not.
>    The zero-amount / blank-date fragments pass through the salvage parser and `normalizeTransactions`
>    silently, exactly as predicted.
>
>    **Mitigation shipped (low-cost, scoped).** Raised `CHUNK_THRESHOLD` 12 KB → 24 KB. Chunking only
>    ever existed to stay inside the context window, but `/api/ollama` runs `num_ctx: 32768` (~32 KB
>    of text) — 12 KB was far more conservative than needed, needlessly routing ordinary multi-page
>    statements through the boundary-unsafe path. At 24 KB, realistic statements (typically 5–20 KB)
>    now take the single-request path that extracts boundary transactions correctly, while still
>    chunking genuinely huge statements before they can overflow context. A **full** fix (cross-page
>    continuation — feeding the previous page's trailing partial row as context, with dedup) is
>    deferred as out of scope for this turnaround: for the now-rare huge statements that still chunk,
>    the residual error is one corrupt row per physical page break, small relative to the whole. The
>    limitation and rationale are documented in a code comment on `CHUNK_THRESHOLD` in
>    `UploadFlow.tsx`, so it does not ship as an unstated assumption.
> 4. **SQL retry loop — done, validated.** `app/api/chat/route.ts` now gives a failed model query
>    exactly one repair round-trip (failed SQL + SQLite error → "Return a corrected SQLite SELECT")
>    before surfacing the error; the corrected query is what runs and what's reported. Verified live
>    against **qwen2.5:32b**: fed a query with `SUM(amt)` → error `no such column: amt`, the model
>    returned `SUM(amount)` (valid, corrected).
>
> Tests: `tests/llmModels.test.ts` pins the role/annotation metadata. `npm run test:run` green
> (89 passed). `npm run build` compiles clean. `npm run lint` unchanged from baseline (16 pre-existing
> errors in untouched files — Phase U2/U4 debt; zero introduced by this work).

### Phase 6 — Data integrity (implements FOLLOWUPS.md)

- **6.1 Soften transfer delete cascade** (FOLLOWUPS §2): add `createdVia String @default("import")`
  to Transaction (migration + set `'manual'` in `/api/transactions/manual` and the counterpart
  creation paths). `DELETE /api/transactions/[id]`: cascade to the counterpart only when the
  counterpart's `createdVia === 'manual'`; otherwise unlink (null both pointers) and delete only the
  requested row. Return `{ deletedCounterpart: boolean }` so the UI can message accurately.
- **6.2 DB constraints** (FOLLOWUPS §5): in a **follow-on migration — deliberately not folded
  into the 0.1 baseline** (the baseline is marked applied on the live DB without executing, so
  anything folded into it would never reach the existing database; see the note under 0.4): add
  `CHECK ((transactionType = 'debit' AND amount <= 0) OR (transactionType = 'credit' AND amount >= 0) OR transactionType = 'transfer')`
  via raw SQL in the migration file (Prisma schema can't express CHECK; SQLite requires a
  `CREATE TABLE` rebuild — copy rows, drop old, rename — since `ALTER TABLE ADD CONSTRAINT` isn't
  supported). Before writing the migration, run the CHECK predicate as a SELECT against the live
  DB to confirm zero violating rows (FOLLOWUPS §3 anomalies would make the rebuild fail midway).
  Also switch split legs to `onDelete: Cascade` on `parentTransaction`.
- **6.3 Bulk reimbursement linking** (FOLLOWUPS §1): in the ledger pending-reimbursements view, add
  "Suggest matches": `GET /api/reimbursements/suggest` pairs each unlinked `reimbursableFor` expense
  with candidate credits (same currency, amount within ±1%, date after expense, category
  `Reimbursement` or description similarity) and the user confirms each. Reuse the existing
  `/api/transactions/[id]/reimburse` link endpoint per confirmation.
- **6.4 Category referential tidiness:** `PATCH /api/transactions/bulk` and single PATCH should
  warn (not reject) when `category` doesn't exist in the Category table; ledger currently lets
  arbitrary strings in, which then don't appear in Settings. Cheapest fix: auto-create the category
  (with palette color) on first use, matching the CategoryManager behavior.

> **M5a status (Phase 6): DONE.** Implemented on `claude/m5a-data-integrity`.
>
> 1. **6.1 Soften transfer delete cascade — done.** `createdVia String @default("import")` added to
>    `Transaction` via migration `20260716201136_add_transaction_created_via`. Set to `'manual'` in
>    `POST /api/transactions/manual` (both the single-row and two-sided-transfer paths) and in the
>    re-pair branch of `PATCH /api/transactions/[id]` that creates a fresh counterpart. `DELETE
>    /api/transactions/[id]` now reads the counterpart's `createdVia` before deciding: cascades only
>    when it's `'manual'`, otherwise nulls `linkedTransferId` on the surviving row and deletes only
>    the requested row. Response includes `{ deletedCounterpart: boolean }`;
>    `app/ledger/_components/deleteWithUndo.ts` reads it and swaps the "Transaction deleted" toast
>    for one explaining the linked transfer was imported and kept unlinked, when applicable. Split-leg
>    cascade logic in the same route is left explicit (see 6.2) rather than removed.
> 2. **6.2 DB constraints — done, validated structurally, not against volume.** Follow-on migration
>    `20260716201150_split_leg_cascade_and_check_constraint` hand-adds
>    `CHECK ((transactionType = 'debit' AND amount <= 0) OR (transactionType = 'credit' AND amount >= 0) OR transactionType = 'transfer')`
>    to the rebuilt `Transaction` table and switches `parentTransaction`'s FK to `ON DELETE CASCADE`
>    (mirrored in `schema.prisma` as `onDelete: Cascade`). The negated-predicate SELECT was run
>    against `dev.db` before writing the migration and returned 0 rows — **but `dev.db` in this
>    environment was freshly created from the baseline migration and empty** (no `dev.db` shipped;
>    per the plan's own prior note it was intentionally cleared), so this is a structural check only,
>    not a validation against real transaction volume. Confirmed the constraint actually rejects bad
>    inserts (`CHECK constraint failed` on a manually-crafted violating INSERT) and that the schema/DB
>    now agree via `prisma generate` + `prisma migrate dev`. The app-level split-leg
>    `deleteMany({ parentTransactionId })` in `DELETE /api/transactions/[id]` is kept (not removed)
>    for clarity of what the transaction does, now backed up by the DB-level cascade.
> 3. **6.3 Bulk reimbursement linking — done.** `GET /api/reimbursements/suggest` scores every
>    (outstanding expense, candidate credit) pair — same account currency, credit amount within ±1%
>    of `abs(expense.amount)`, credit dated after the expense, and either `category === 'Reimbursement'`
>    or description-similarity ≥ 0.4 — then greedily assigns highest-score pairs first so no credit is
>    suggested for two expenses. The bigram-Dice `similarity()` helper duplicated in
>    `check-duplicates/route.ts` was extracted to `lib/textSimilarity.ts` (`descriptionSimilarity`) and
>    both routes now import it. `app/ledger/_components/ReimbursementSuggestModal.tsx` is a new
>    "Suggest matches" entry point next to the ledger's pending-reimbursements banner
>    (`LedgerView.tsx`); it lists each suggested pair with Confirm/Dismiss, Confirm calling the
>    existing `POST /api/transactions/[id]/reimburse`. No new linking logic — the modal is purely a
>    bulk entry point onto the endpoint that already existed.
> 4. **6.4 Category referential tidiness — done.** Both `PATCH /api/transactions/bulk` and
>    `PATCH /api/transactions/[id]` now `prisma.category.upsert` (`update: {}`, so an existing
>    category's color is never touched) with `colorForCategory()` — the same palette function
>    `POST /api/categories` already uses — whenever the patch sets a `category` value, instead of
>    silently letting an orphan string in.
>
> **Tests:** `tests/textSimilarity.test.ts` (the extracted similarity heuristic),
> `tests/reimbursementSuggest.test.ts` (8 cases: category match, description-similarity match, ±1%
> tolerance rejection, date-ordering rejection, cross-currency rejection, already-linked-settlement
> exclusion, no-double-assignment, non-committed/already-linked exclusion), and
> `tests/transactionDeleteCascade.test.ts` (5 cases covering the createdVia cascade/unlink split, no
> linked transfer, split-leg cascade, and delete-of-missing-row) — all against an in-memory fake of
> the Prisma calls each route makes, following the existing mock-prisma pattern in
> `tests/transactionValidation.test.ts` (no route-handler tests existed before this PR to follow, so
> this establishes that pattern for future route work). `npm run test:run`: 106 passed (was 89).
> `npm run lint`: same 16 pre-existing errors in untouched files as baseline, zero introduced.
> `npm run build`: compiles clean, `/api/reimbursements/suggest` listed as a new route.
>
> **Caveat:** the CHECK-constraint predicate could only be checked against an empty `dev.db` in this
> environment (see 6.2 above) — it is unverified against real transaction volume until run against a
> populated database.

### Phase 7 — Product gaps (to rival a polished tracker)

Ordered by value for a single home user:

1. **CSV/OFX statement import.** Most banks export CSV; it's exact, instant, and skips the whole
   OCR+LLM path. New tab in the upload page: file → header-mapping UI (date/description/amount or
   debit+credit columns, date format picker) → same ReviewTable flow. Store the mapping per account
   in Settings for one-click re-imports. This is the single biggest reliability upgrade available.
2. **Reconciliation flow.** The `reconciled` status exists but there's no workflow. Per account:
   enter statement closing balance + date → app shows computed balance from `committed+reconciled`
   rows up to that date and the delta → one click marks the period's rows `reconciled` when the
   delta is zero. Surface per-account "last reconciled" on the dashboard balances rail.
3. **Backup restore.** `BackupManager` can create/download but not restore. Add restore (server
   copies the snapshot over `dev.db` after making a safety backup, then prompts app restart).
   Dramatically improves the safety story that already half-exists.
4. **Net-worth history.** The NetWorth widget shows only the current number. Compute a monthly
   series (opening balances + cumulative sums per month — one grouped SQL query) and add a line
   chart to the dashboard.
5. **Recurring → upcoming bills.** `/api/recurring` already detects cadence; project each series'
   next expected date/amount and show "Upcoming this month" on the dashboard with overdue
   highlighting.
6. **Budget UX.** Budgets exist; add per-category month history sparkline in `BudgetWidget` and an
   "over budget" callout. (Skip envelope/rollover mechanics — overkill for this app.)
7. **Rules retro-apply.** In `VendorRuleManager`, "Apply to existing" button per rule → bulk-update
   matching uncategorized transactions (server endpoint reusing the SQL matchers from 3.2, dry-run
   count first).
8. **Empty states & first-run.** A fresh DB shows blank pages. Add a guided first-run card on the
   dashboard: 1) create account → 2) import statement → 3) set budgets, each linking to the page.
9. **Keyboard support** in the ledger: `/` focuses search, `e` edits focused row, arrows navigate.

> **M8c status (item 7 — Rules retro-apply): DONE.** Implemented on `claude/m8c-rules-retro-apply`.
> `POST /api/vendor-rules/[id]/apply` reuses `matchesRule` from `lib/vendor-rule-match.ts` (the
> Phase 3.2 matcher, not a reimplementation) against uncategorized rows (`category === ''`, the
> schema default) with status `committed`/`reconciled`. `?dryRun=1` returns `{ count }` without
> writing; the real POST re-checks `category: ''` at write time (`updateMany` where clause) so a
> race with another categorization between read and write can't clobber it, upserts the target
> category via `colorForCategory` (same Phase 6.4 auto-create pattern as
> `PATCH /api/transactions/bulk`), then returns `{ updated }`. `VendorRuleManager` gained a
> "Apply to existing" button (`CheckCheck` icon) next to the existing Test button: click →
> dry-run count fetched into a `Modal` confirmation ("This will categorize N uncategorized
> transactions as X. Continue?") → confirm → real apply → `useToast` success/error, matching the
> file's existing button/modal/toast conventions. Test: `tests/vendorRuleApply.test.ts` (in-memory
> mock-prisma, same pattern as `tests/transactionDeleteCascade.test.ts`) — 5 cases covering 404 on
> unknown rule, dry-run doesn't write, apply skips already-categorized rows, direction/amount/
> pattern gates, and the zero-match no-op skipping the category upsert. `npm run lint`: same 3
> pre-existing warnings in untouched files, zero introduced. `npm run test:run`: all passing tests
> green (216 passed; `tests/sqlGuard.test.ts`'s 6 failures are a pre-existing environment gap —
> no `dev.db` in this worktree until `prisma migrate deploy` was run for the build check — verified
> identical failures on `main` before this change). `npm run build`: compiles clean,
> `/api/vendor-rules/[id]/apply` listed as a new route.

### Phase 8 — Testing, tooling, deployment

- **Seed script** `scripts/seed.ts` (accounts + 50k realistic transactions incl. splits, transfers,
  reimbursements) — required to validate Phases 1–2 and useful forever.
- **Tests to add:** `statementFormats` normalization table-driven tests; transactions query API
  (filters/sort/pagination/stats) against a fixture DB; dashboard SQL vs JS oracle (Phase 2);
  duplicate-check; SQL row cap. Vitest is already configured.
- **Playwright smoke** (optional but cheap): boot production build, visit each page, assert no
  console errors, run one ledger edit round-trip.
- **CI:** GitHub Actions running `lint`, `test:run`, `build` on push.
- **Ops:** document (README "Home server" section): systemd unit, `OLLAMA_URL`, backup location,
  and that WAL mode creates `dev.db-wal/-shm` files that must be backed up together (the existing
  `db.backup()` API handles this correctly — note that file-copy backups by hand do not).

> **M7a status (Phase 8): DONE.** Implemented on `claude/m7a-testing-tooling`.
>
> 1. **Seed script — done.** `scripts/seed.ts` (`npm run seed`, uses `tsx`) generates 5 accounts
>    covering every type in `lib/accounts.ts` (current, savings, credit, personal_loan, auto_loan)
>    and ~48k transactions over 3 years, including split parents/legs, linked transfer pairs, and
>    matched/pending reimbursements, respecting the debit/credit sign rules by construction. It's
>    idempotent (only touches accounts named with a `[seed] ` prefix, so it's safe next to real
>    data) and seeded rows pass `PRAGMA foreign_key_check` after insert (verified, not assumed —
>    the script disables FK enforcement on its own connection only, to avoid mutual-reference
>    ordering issues between paired rows in the same `createMany` batch, then checks for real
>    dangling references afterward and fails loudly if any exist).
> 2. **Real perf validation against the seed data — found and fixed a genuine regression.**
>    Running the actual `/dashboard` route against the ~48k-row seed (the exact validation Phase 1
>    and Phase 2 both deferred for lack of seed data — see their status notes above) surfaced a
>    **52-second** dashboard load, not the ~150ms guardrail. Root cause, confirmed with
>    `EXPLAIN QUERY PLAN`: `inclusionSql()`'s two correlated `NOT EXISTS` subqueries
>    (`lib/transactions-query.ts`) — checking "does this row have split legs" / "is this row a
>    matched reimbursement settlement" — have an obviously-selective equality predicate available
>    (`parentTransactionId = ?` / `reimbursementTxId = ?`, at most one match each), but once a
>    `dateLtIso` bound is added (the pre-range net-worth queries), SQLite's planner instead picked
>    `Transaction_accountId_date_idx`, a *range* scan re-run per outer row — effectively O(n·m) over
>    ~48k rows. Fixed by adding `INDEXED BY "Transaction_parentTransactionId_idx"` /
>    `INDEXED BY "Transaction_reimbursementTxId_key"` to those two subqueries, forcing the
>    already-correct index choice regardless of account-id count or date-range width. Re-measured
>    after the fix: **52s → ~40ms** for the isolated query, **~350ms warm** for the full
>    `/dashboard` route (vs. the ~0.3s recorded in the real-hardware §0.5 baseline at a similar row
>    count) — this closes out the "unbenchmarked" caveats left by M2b/M3. `tests/dashboard.oracle.test.ts`
>    gained the matching indexes on its in-memory fixture (so the oracle test exercises the exact
>    same SQL text/plan-relevant index names as the real schema) and a regression guard that pins
>    the `INDEXED BY` hints stay present. This was a correctness-neutral, perf-only change — the
>    oracle test (unchanged assertions) still passes, confirming the aggregated numbers didn't move.
> 3. **Tests — done.** `tests/statementFormats.test.ts` (36 table-driven cases: format detection
>    precedence/1500-char window, credit-card PAYMENT/PROFIT/safety-net branches, bank-account
>    transfer-keyword detection, SKIP filtering, unknown-format fallback).
>    `tests/transactionsApi.test.ts` drives the real `GET /api/transactions` route handler (not just
>    the query builders, which already had oracle coverage) against an in-memory SQLite fixture via
>    a `@/lib/prisma` mock backed by real SQL — filters, sort, pagination, stats exclusions, relation
>    hydration, and CSV export. `tests/checkDuplicates.test.ts` covers the duplicate-check route
>    (amount/date/description-similarity matching, cross-account exclusion, invalid-candidate
>    skip-and-continue, no artificial cap). `tests/ledgerRowCap.test.ts` is the dedicated row-cap
>    test for the ledger's `pageSize` clamp (`tests/sqlGuard.test.ts` already covered the separate
>    chat-SQL `READONLY_ROW_CAP`). `npm run test:run`: 217 passed (was 210 on `main`).
> 4. **Playwright smoke — evaluated, deferred.** Installed `@playwright/test` and attempted
>    `npx playwright install chromium`; the sandbox's outbound proxy rejects the Chrome-for-Testing
>    CDN host (`cdn.playwright.dev`) with a 403, so no browser binary could be fetched to actually
>    run and validate a smoke test in this environment. Per the plan's own "optional but cheap...
>    only if it doesn't blow the time budget; seed script and Vitest tests are the priority" framing,
>    and since shipping an unverified/never-run browser test risks a silently-broken CI job, this was
>    backed out (`@playwright/test` removed from `package.json`) rather than committed blind. A real
>    CI runner has normal internet access and wouldn't hit this proxy restriction, so this remains a
>    reasonable follow-up for whoever next touches CI — nothing here should stop them from adding it.
> 5. **CI — done.** `.github/workflows/ci.yml` (new — no CI existed before): `npm ci` →
>    `npx prisma generate` → `npx prisma migrate deploy` (the build step prerenders `/guide`, which
>    reads Settings, so a migrated `dev.db` must exist before `next build` runs) → `npm run lint` →
>    `npm run test:run` → `npm run build`, on push to `main` and on every PR.
> 6. **Ops docs — done.** New README "Home server" section: the systemd unit walkthrough
>    (`deploy/ydb.service` already existed from Phase 0.3; this documents how to install/adjust it),
>    `OLLAMA_URL` / the `ollamaUrl` Setting precedence, backup location and retention, and — the
>    plan's specific ask — *why* WAL mode means a bare `cp dev.db` can silently lose recent
>    transactions (they may still be sitting only in `dev.db-wal`) and why `lib/backup.ts`'s
>    `createBackup()` (SQLite's online backup API via `better-sqlite3`'s `Database#backup()`) avoids
>    that, plus a note that `restoreBackup()` checkpoints and clears the `-wal`/`-shm` sidecars before
>    swapping the file so a restore can't be shadowed by stale WAL pages.
>
> **Verify:** `npm run lint` — same 17 pre-existing errors / 14 warnings as `main` (confirmed via a
> pre-change baseline run), **zero introduced** by this PR, matching the "green" convention every
> prior M-phase status note in this file has used (a fully clean `npm run lint` has never been true
> on `main`; fixing that pre-existing debt is out of scope for Phase 8 and risks conflicting with
> the parallel M7b UI branch). `npm run test:run`: 217 passed. `npm run build`: compiles clean.
> `npm run seed` verified end-to-end (idempotent re-run, `foreign_key_check` clean, sign rules
> respected — spot-checked directly against the seeded `dev.db`).

---

## 3. UI/UX review & plan

Reviewed: `globals.css`, `Design Guide.md`, layout/nav/theme, every page and interactive component
(ledger, dashboard, upload/review, chat, settings, modals, DatePicker, dropzone, error/404 pages).
The app has a genuinely distinctive, coherent visual identity (warm Cursor-inspired palette, full
dark-mode variable set, three-font system, tasteful micro-animations). The problems are structural:
the design system exists only as **repeated inline styles**, accessibility is an afterthought,
mobile is essentially unsupported, and feedback patterns are inconsistent (`alert()`, silent
catches, no toasts, no loading states).

### UI/UX findings

**Bugs / broken styling**
- `app/chat/_components/ChatPane.tsx:308,360` references `var(--border)`, which is **not defined**
  in `globals.css` (only `--border-warm*` exist) — the composer border and disabled send-button
  background silently resolve to invalid values.
- `app/globals.css:243-247` forces `font-weight: 600` and a press-scale transform on **every**
  button in the app — this is why some "buttons" look bolder than intended and checkboxes/icon
  buttons visibly shrink on click.

**Design-system debt**
- `backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)'`-style inline props
  are repeated in essentially every component; `LedgerView`, `LedgerRow`, `ReviewTable` each define
  their own private `cardStyle` / `selectStyle` / `selectDropdownStyle` copies. There are **three
  independent Radix Select wrappers** (`FilterSelect` in LedgerView, `TypeSelect` + `SimpleSelect`
  in LedgerRow, more inside ReviewTable) with duplicated markup.
- Hover states are implemented in JS (`onMouseEnter`/`onMouseLeave` mutating `element.style`) in
  dozens of places — no keyboard-focus parity, does nothing on touch, and bloats every component.
- No shared Button/Card/Input/Badge/Modal primitives; radius (4/6/8/10/12/16px), icon sizes
  (9–40px), and heading styles (`text-[26px]` + inline `letterSpacing`) are ad hoc per file.
- The orange accent (`--color-accent`) is used as a primary button exactly once (upload "Extract
  Transactions"); every other action is the same beige button — no visual action hierarchy.

**Accessibility**
- Only 5 files contain any `aria-*` attribute. Most icon-only buttons (row delete ✕, unlink,
  scissors/split, chat-session delete) have `title` at best, no `aria-label`.
- Ledger row actions are `opacity-0 group-hover:opacity-100` — invisible to keyboard users (they
  can still be focused while invisible) and unreachable on touch devices.
- All modals (`AddCategoryModal`, `TransferLinkModal`, `ReimburseLinkModal`, DangerZone modal) are
  hand-rolled portals: no `role="dialog"`, no `aria-modal`, no focus trap, inconsistent Escape
  handling. Radix primitives are already a dependency — Radix `Dialog` should be used.
- Sortable ledger headers are `<th onClick>` with no button semantics or keyboard support.
- Inputs get a global orange focus ring (good) but buttons/links widely use `outline: none` with
  no visible replacement (DatePicker trigger, nav links, select triggers).
- Contrast: `--tx-faint` (35% opacity) and `--tx-tertiary` (40%) at 10–11px font sizes fail WCAG
  AA; used for genuinely informative text (original descriptions, split legs, timestamps).
- No `prefers-reduced-motion` guard on any animation; theme ignores `prefers-color-scheme`
  (first visit is always light regardless of OS setting).

**Responsive / mobile — effectively unsupported.** A home-server app gets used from phones on the
couch; this matters. Only 5 responsive utility usages exist in the whole app (page padding only):
- Header nav (6 items) has no collapse — wraps/overflows below ~500px.
- Ledger stat cards are a fixed `grid-cols-3`; the table needs ~900px and the edit drawer's
  `flex-wrap` fields get chaotic; the fixed-position bulk bar (`whiteSpace: nowrap`) overflows.
- Chat sidebar is a fixed 220px column with no collapse — chat is unusable on a phone.
- Dashboard chart grids don't reflow; the filter bar pushes the date range off-canvas.

**Feedback & state handling**
- Errors: native `alert()` (`LedgerView.tsx:246`, `LedgerRow.tsx:271`), native `confirm()` for
  deletes (`LedgerRow.tsx:266`), and several **silent** `catch { /* silent */ }` handlers
  (unlink, rule save) where a failure gives the user no signal at all.
- `DangerZone.handleClear` never checks `res.ok` — a failed wipe closes the modal as if it
  succeeded.
- No `loading.tsx` for any route: with the current slow queries, navigation appears frozen with
  zero pending feedback (compounds the perf problem perceptually).
- Upload flow never tells the user which statement format was detected (`credit-card` vs
  `bank-account` drives sign interpretation!) and offers no override when detection is wrong.
- Chat has no stop-generation button (upload does), no copy-answer affordance, and raw SQLite
  error strings are shown verbatim.
- The upload "done" screen offers "Upload another" but no link to the ledger to see the result.

**Information architecture & consistency**
- **Dashboard is missing from the nav** (`NavLinks.tsx` lists Ledger/Chat/Upload/Guide only; the
  dashboard is reachable only via the logo) and the settings link is labeled "Config" while the
  page calls itself "Settings".
- **The ledger has no date filter** — the single most useful filter for a transaction list (the
  dashboard has a range picker; the ledger does not).
- Number formatting is inconsistent: ledger stats use `toFixed(2)` (no thousands separators, so
  `AED 123456.78`), the dashboard uses `toLocaleString`, and `lib/money.ts` already exports
  `formatCents` that almost nobody uses. Spacing is also inconsistent (`+AED 50.00` vs `AED50.00`).
- Dates render as raw ISO `YYYY-MM-DD` in tables but `14 Jul 2026` in the DatePicker.
- Categories have colors (`Category.color`, curated palette) that are shown **nowhere** except the
  trend chart — ledger and review tables show plain text.
- Settings is one very long scroll: Accounts → Categories → Vendor Rules (800-line manager) →
  Budgets → Recurring → Imports → Backups → Danger Zone, with no section nav.
- Fonts ship as 9 raw `.ttf` files (7 IBM Plex Mono weights alone) — convert to woff2 and drop
  unused weights; this is both a perf and first-paint polish issue.

### Phase U1 — Design-system consolidation (do before other U-phases; pairs well with Phase 1 work)

Create `app/_components/ui/` with small primitives that encode the existing look (values from
`globals.css` vars and `Design Guide.md` — this is a refactor, **not** a redesign):
- `Button.tsx` — variants: `primary` (accent orange, one per screen), `default` (beige),
  `ghost`, `danger`; sizes `sm|md`. CSS-class hover/focus states, not JS.
- `Card.tsx` (bg-card + border-warm + radius 8), `Input.tsx`, `Field.tsx` (label + control),
  `Badge.tsx` (status/type pills), `Select.tsx` (ONE Radix Select wrapper replacing the three
  copies — hover via `data-highlighted` CSS, not mouse handlers), `Modal.tsx` (Radix Dialog:
  focus trap, Escape, `aria-modal`, overlay click, shared card styling).
- Add utility classes in `globals.css` (`.card`, `.h-page`, `.h-section`, `.text-meta`) for the
  repeated heading/caption patterns; migrate the JS hover handlers to `:hover` /
  `[data-highlighted]` CSS rules.
- Fix the two style bugs: define `--border` (alias of `--border-warm`) or fix the two ChatPane
  references; scope the global `button { font-weight:600; scale }` rule to a `.btn` class.
- Migration order: LedgerView/LedgerRow (worst offenders) → ReviewTable → settings components →
  the rest. Each screen should look pixel-identical after migration (compare screenshots) —
  except where a U1.5 token improvement below intentionally changes it.
- Verify: `grep -rn "onMouseEnter" app | wc -l` drops to ~0; no component defines its own
  `selectDropdownStyle`/`cardStyle` copies.

### Phase U1.5 — Design-system improvements (proposals, apply during the U1 migration)

The current system is 90% of a good design system; these close the gaps. All are token/convention
changes, not a redesign — the warm Cursor-inspired identity stays.

1. **Fill the token gaps.** The semantic-variable set in `globals.css` is missing states that
   components hardcode today:
   - `--tx-transfer` / `--bg-transfer`: the transfer amber (`#F59E0B`, `#92400E`,
     `rgba(245,158,11,…)`) is hardcoded in **11 places across 5 files** with **no dark-mode
     variant** — `#92400E` (dark brown) text on dark backgrounds is near-invisible. Add light +
     dark values (e.g. dark: `#fbbf24` text on `rgba(245,158,11,0.15)`), replace all occurrences.
   - `--bg-overlay`: modal scrims hardcode `rgba(0,0,0,0.5)` in 3 places; dark mode wants a
     heavier scrim (`rgba(0,0,0,0.65)`).
   - `--focus-ring`: the orange input glow is duplicated in light/dark blocks; make it a token and
     reuse it for button/link `:focus-visible` (U2).
   - `--border`: alias of `--border-warm` (fixes the ChatPane bug permanently instead of just
     editing two call sites).
   - Motion tokens: `--dur-fast: 100ms; --dur-base: 150ms; --dur-slow: 200ms;
     --ease-out: cubic-bezier(0.22,1,0.36,1)` — the codebase already uses exactly these values,
     just inconsistently inline.
2. **Establish an action hierarchy.** Today the accent orange appears on exactly one button in the
   app; everything else is the same beige, so nothing guides the eye. Convention: **one orange
   primary per screen** — Commit (review table), Extract (upload), Save (ledger edit drawer / add
   form), Apply (bulk bar) — beige `default` for everything else, `ghost` for cancel/dismiss,
   crimson `danger` (filled) reserved for destructive confirms. Encode as the `Button` variants;
   this is the one intentional visual change of the phase.
3. **Collapse the status-color triplets.** `--bg-badge-committed` / `--bg-notify-success` /
   `--bg-stat-income` are three names for the same green (same for the red set). Reduce to one
   semantic pair per hue (`--bg-positive`/`--tx-positive`, `--bg-negative`/`--tx-negative`,
   `--bg-caution`/`--tx-caution`, `--bg-info`/`--tx-info`) with the badge/stat/notify components
   consuming them. Fewer tokens, zero drift risk, and dark mode is defined once per hue.
4. **Codify the type scale as classes.** `.text-page-title` (26px/−0.325px), `.text-section`
   (22px/−0.11px), `.text-card-label` (11px uppercase tracked), `.text-meta` (12px secondary) —
   the four styles every page hand-rolls with `text-[26px]` + inline `letterSpacing`. Headings
   already inherit the display font from the `h1–h4` rule; the classes make the sizes consistent
   and greppable.
5. **Number typography rule.** All amounts render in the mono font with `font-variant-numeric:
   tabular-nums` (add to a `.amount` class) so columns of figures align — currently amounts mix
   mono and default and never set tabular numerals. Signs: always typographic minus `−` (already
   mostly used) and a leading `+` only in stat cards, never in table cells (currently mixed).
6. **Elevation discipline.** Three levels only: flat (border only), raised (`--shadow-ambient` —
   popovers, dropdowns), overlay (`--shadow-card` — modals, the bulk bar). Today dropdowns use the
   heavy modal shadow; align them to `raised` so modals feel meaningfully "above" menus.

Verify: `grep -rn "F59E0B\|92400E\|rgba(245" app --include='*.tsx'` returns nothing;
dark-mode screenshots of a transfer-heavy ledger page are legible; every screen has at most one
orange button visible per section.

### Phase U2 — Accessibility pass ✅ (M5b)

- Replace all hand-rolled modals with the new Radix `Modal.tsx` (U1). Keep the DangerZone
  typed-confirmation content — it's a good pattern; make it the standard destructive-confirm.
- Icon-only buttons: `aria-label` on every one (row actions, sidebar deletes, theme toggle
  already has one). Sortable headers become `<button>` inside `<th>` with `aria-sort`.
- Ledger row actions: visible at reduced opacity (e.g. 0.4 → 1 on hover/focus-within) instead of
  `opacity-0`, so keyboard and touch users can find them. Add `:focus-visible` styles for buttons/
  links/nav (reuse the orange ring), and remove bare `outline: none` without replacement.
- Bump minimum body-adjacent text to 12px and raise `--tx-faint`/`--tx-tertiary` to pass AA for
  informative text (decorative hints may stay).
- Wrap animations in `@media (prefers-reduced-motion: no-preference)`; make the theme-init script
  fall back to `prefers-color-scheme` when localStorage is empty, and add a "System" option to
  `ThemeToggle`.
- ChatSidebar session rows become buttons; chat thread gets `aria-live="polite"` on the streaming
  message container.
- Verify: keyboard-only walkthrough of ledger edit, upload commit, and danger-zone flows; axe
  DevTools (or `@axe-core/playwright` in the Phase 8 smoke) reports no critical issues.

> **M5b status:** done, verified with a real `@axe-core/playwright` scan (dev-only dependency,
> not added to `package.json`) against `/ledger`, `/dashboard`, `/chat`, `/settings`, `/upload`.
> **Modals:** confirmed all modals already route through `Modal.tsx` (DangerZone, TransferLinkModal,
> ReimburseLinkModal, AddCategoryModal, AddAccountModal, LedgerRow's delete confirm,
> LedgerRowCard) — no hand-rolled portals or `alert`/`confirm` remained; this had already landed by
> M3/M4 as the plan predicted. **Icon-only buttons:** added the handful of missing `aria-label`s
> (LedgerRow's unlink/link/split actions, LedgerView's filter-chip clear buttons, CategoryManager's
> save/cancel), then went further based on what axe actually flagged with real ledger rows: the
> per-row/select-all checkboxes had no accessible name (`label-title-only`/`label` violations —
> `title` alone isn't sufficient), several Radix `Select` triggers across LedgerView/ReviewTable/
> BudgetManager/VendorRuleManager/PreferencesForm rendered with no accessible name despite visible
> text (Radix quirk — content alone didn't satisfy the accessible-name computation; fixed by adding
> explicit `aria-label`/threading an `ariaLabel` prop through the `Select`/`SimpleSelect`
> wrappers), the empty actions `<th>` got a `sr-only` label, and the upload dropzone's hidden file
> input got an `aria-label`. **Sortable headers:** `LedgerView`'s date/description/amount/category
> headers are now `<button>` inside `<th aria-sort>`, verified `aria-sort` flips
> none→ascending→descending on click via Playwright. **Row actions:** ledger row and
> VendorRuleManager pattern-row actions go from `opacity-0` to `opacity-40`, with
> `group-focus-within:opacity-100` added alongside `group-hover`; a global
> `button/a/[role=button]/[role=tab]/summary:focus-visible` rule (reusing `--focus-ring`) was added
> to `globals.css` so DatePicker/calendar buttons, nav links, and Select triggers all get a visible
> ring where they previously had bare `outline: none`. **Contrast:** `--tx-faint` and
> `--tx-tertiary` raised (light: 0.35→0.64, 0.40→0.66; dark: 0.35→0.50, 0.40→0.53 alpha) — both now
> clear 4.5:1 against `--bg-card`/`--bg-page` (verified with a contrast-ratio script, not just
> eyeballed); the dozen or so genuinely-informative sub-12px text spots found via grep (original
> descriptions, notes, account-name captions, chat timestamps, credit-utilization captions) were
> bumped to `text-xs` (12px) — uppercase field/table-header labels and badges stayed at their
> existing 10–11px since `.text-card-label` (11px) is itself an established U1.5 token, not a new
> violation. **Caveat found but out of scope:** the axe scan also surfaced that `--tx-secondary`
> (0.55 alpha, used for nav links, table headers, and the `--tx-positive`/`--tx-negative` status
> colors on tinted badge backgrounds) sits around 3.4–4.2:1, short of AA — this is a much larger,
> pre-existing design-system-wide issue (hundreds of nodes across every page) outside this phase's
> explicit `--tx-faint`/`--tx-tertiary` scope and the "no visual redesign" non-goal; flagged here as
> a candidate for a future U1.5/U6 follow-up rather than fixed inline. Also unfixed: `/chat` has no
> `<h1>` (axe `page-has-heading-one`, moderate, page-level IA decision beyond this phase).
> **Reduced motion:** added a `prefers-reduced-motion: reduce` block in `globals.css` that zeroes
> `animation-duration`/`animation-iteration-count` globally (`!important`, since several entrance
> animations — calendar popover, toast, drawer — are inline `style` values that a class-scoped
> `no-preference` wrapper couldn't reach); CSS `transition`s used for hover/focus feedback are
> untouched. **System theme:** the `theme-init` inline script now falls back to
> `prefers-color-scheme: dark` when `localStorage` has no `theme` key or the key is `'system'`;
> `ThemeToggle` is a 3-way light→dark→system cycle button, storing `'system'` and re-checking
> `matchMedia` at read time (plus a live `change` listener while `system` is active, so an OS theme
> flip is reflected without a reload). **Chat:** `ChatSidebar` session rows are now `<button>`s with
> `aria-label`/`aria-current`, restructured as a sibling to the delete button instead of nesting a
> button inside a clickable div; `ChatPane`'s message-thread container has
> `role="log" aria-live="polite" aria-relevant="additions text"` (not `assertive`, so streaming
> tokens don't interrupt). **Verified:** `npm run test:run`/`lint`/`build` all green (lint's 16
> errors/13 warnings are pre-existing on `main`, unchanged by this PR); a Playwright keyboard-only
> walkthrough confirmed Enter opens the ledger edit drawer and the DangerZone modal, focus moves
> into the modal, and Escape closes it; axe found zero `critical`/`serious` issues left on the
> four pages other than the pre-existing `--tx-secondary` contrast caveat above.

### Phase U3 — Responsive / mobile ✅ (M4)

Target: fully usable on a ~390px phone; comfortable on tablet.
- **Nav:** ✅ collapses to a hamburger below `md` (Radix `Popover`, not `DropdownMenu` — avoided a
  new dependency since `@radix-ui/react-popover` was already installed). `MobileNav` in
  `NavLinks.tsx` lists all links including Dashboard and Settings, which aren't both in the
  desktop rail yet (Dashboard nav placement is U5's job — the mobile menu just doesn't wait for it).
- **Ledger:** ✅ stat cards `grid-cols-1 sm:grid-cols-3`. Below `md`, rows render as
  `LedgerRowCard.tsx` (date/description/amount/badges, actions behind an overflow chevron) instead
  of the table; `deleteWithUndo.ts` was factored out of `LedgerRow.tsx` so both the desktop row and
  the mobile card share the exact same undo-delete logic (including the reimbursement-link and
  partial-failure fixes from the Phase 4 PR's review round). Bulk bar is a full-width bottom sheet
  below `md`, a centered pill at `md+`. Filters collapse behind a "Filters" disclosure with an
  active-filter-count badge and clearable chips shown when collapsed; `md:contents` on the
  filter-fields wrapper keeps the `md+` layout pixel-identical to before.
- **Chat:** ✅ `ChatSidebar` split into a static `md+` rail and a `MobileChatDrawer` (Radix `Dialog`,
  slide-over from the left, new `.ui-drawer-*` CSS primitive in `globals.css`) opened via a
  "Sessions" button in a mobile-only header bar showing the active chat's title.
- **Dashboard:** stat cards `grid-cols-1 sm:grid-cols-3`; filter bar's date-range group only gets
  `ml-auto` at `sm+` (was unconditional, which fought `flex-wrap` on narrow screens) and itself wraps.
  No other chart grids needed stacking — they were already single-column. Balances rail's existing
  horizontal scroll kept as-is.
- **Settings/Upload/Review:** ✅ found and fixed two real overflow bugs via the Playwright sweep
  below, both in `AccountsForm.tsx`'s per-account row: the opening-balance/date/credit-limit/remove
  row was a rigid `grid-cols-[auto_auto_auto_1fr]` that didn't fit 390px (now `flex flex-wrap`), and
  the name/type/currency/active row's fixed auto-columns left the name input less width than its
  intrinsic minimum (now `grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto_auto]` with the four fixed
  fields grouped in a `flex flex-wrap sm:contents` wrapper so they reflow below the name field on
  mobile without changing the `sm+` grid). `TopTransactionsPanel.tsx`'s table was missing the
  `overflowX: auto` wrapper `CashFlowTable.tsx` already had — added.
- Verify: ✅ ran an actual Playwright viewport sweep (390/768/1280 × ledger/dashboard/chat/settings/
  upload/guide, 18 combinations) against the real dev server with a migrated DB — confirmed zero
  horizontal overflow (`scrollWidth === clientWidth`) on every page/width after the two Settings
  fixes above, plus interactive screenshots of the mobile nav menu, ledger filter disclosure, and
  chat drawer opening correctly.

### Phase U4 — Feedback, loading, and error states

- **Toast system** (single `Toaster` in `layout.tsx`, `useToast()` hook — or a tiny dependency-free
  implementation): success ("Saved", "12 transactions committed", "Backup created") and error
  toasts. Replace every `alert()` and every silent `catch` with it. Destructive confirms use the
  U1 Modal (replaces `confirm()`); ledger delete gets the 5-second **Undo** toast (Phase 4 item).
- Fix `DangerZone.handleClear` to check `res.ok` and surface failures.
- **`loading.tsx` for every route** (dashboard, ledger, settings, upload, guide): skeleton cards
  matching each page's layout (stat-card row + table skeleton for ledger, chart placeholders for
  dashboard). Even after Phases 1–2 make pages fast, first-navigation feedback matters.
- **Upload flow:** show the detected format as an editable chip before parsing ("Detected:
  Credit card statement ▾" with the three options) — mis-detection currently flips amount signs
  silently; show a page-progress indicator during chunked parsing (Phase 5); "done" screen links
  to `/ledger?status=review` ("Review them in the ledger →").
- **Chat:** stop-generation button while streaming (wire the existing AbortController pattern from
  UploadFlow); copy button on assistant messages; friendlier error rendering ("The generated query
  failed" + collapsible technical detail instead of a raw SQLite error as the message body).
- Verify: `grep -rn "alert(\|confirm(" app` returns nothing; killing Ollama mid-chat and failing a
  save both produce visible, non-blocking feedback.

> **M3 status:** done. `Toast.tsx` + `useToast()` (`app/_components/ui`), mounted once in
> `layout.tsx`; every `alert()`/silent `catch` across ledger, settings, upload, and chat now routes
> through it (`grep -rn "alert(\|confirm(" app` is empty). `DangerZone.handleClear` checks
> `res.ok`. `loading.tsx` skeletons added for dashboard/ledger/settings/upload/guide
> (`Skeleton.tsx` primitive). Upload flow shows an editable "Detected: X ▾" format chip before
> parsing, whose "done" screen links to `/ledger?status=review`. Chat has a stop-generation button
> wired to the existing `AbortController` and a copy button on assistant messages. **Deferred**:
> the ledger delete 5-second Undo toast is explicitly a Phase 4 item per this plan, not
> implemented here.

### Phase U5 — Information architecture & screen-level UX

- **Nav:** add Dashboard to `NavLinks`; rename "Config" → "Settings" (keep the gear icon); order:
  Dashboard · Ledger · Upload · Chat · Guide.
- **Ledger date filter:** add a date-range control (reuse `DatePicker` pair from the dashboard) to
  the filter bar, wired into the Phase 1 query API (`startDate`/`endDate` params). Add quick
  presets (This month · Last month · 3M · YTD · All) shared with the dashboard's range picker.
- **Money/date formatting:** route ALL amount rendering through `formatCents` /a small `fmtMoney`
  helper (thousands separators, consistent `AED 1,234.56`, minus sign handling) and all table
  dates through one `formatDate` (`14 Jul 2026`). Delete per-component `toFixed(2)` calls.
- **Category color dots** next to category names in ledger rows, review table, category selects,
  and the settings category manager — the colors already exist in the DB; use them.
- **Settings sub-navigation:** sticky in-page section nav (Accounts · Categories · Rules · Budgets
  · Recurring · Imports · Backups · Danger Zone) with anchor scrolling; move Danger Zone visually
  last with stronger separation (it already is last — keep it).
- **Dashboard:** add empty-state cards when there are no transactions in range ("No activity in
  this period" + CTA to upload) instead of blank charts; cap the category-trend chart to the top 8
  categories + "Other" to avoid color soup; add a one-line explanation under the budget widget for
  the months-multiplier behavior.
- **First-run experience** (Phase 7 item 8 — implement here): dashboard onboarding card with the
  3-step checklist when the DB is empty.
- Verify: every page reachable from the nav in one click; a new user can go from empty DB →
  imported statement → categorized ledger without reading the guide.

> **M6 gap-fill status: DONE.** Nav/ledger-date-filter/money-formatting/empty-states/first-run
> landed in `claude/m6b-ia-ux` (#12); this closes the two items M6's checkpoint definition of done
> listed but that PR didn't cover:
>
> 1. **Category color dots — done.** New `lib/category-colors.ts` `categoryColor(name, categories)`
>    looks up a category's persisted colour, falling back to the same deterministic
>    `colorForCategory` the auto-create path already uses, so a dot is never missing even for a
>    category not yet in the `Category` table. New shared `<CategoryDot>` primitive
>    (`app/_components/ui/CategoryDot.tsx`). Wired into: `LedgerRow.tsx` (read-only cell, split-leg
>    rows, and the inline-edit category `Select` via a `dot` per option), `LedgerRowCard.tsx` (the
>    category `Badge`), `LedgerView.tsx` (the hand-rolled Radix category filter), and
>    `ReviewTable.tsx`'s `CategorySelect` (trigger + dropdown items). `CategoryManager.tsx` already
>    rendered full-colour pills, so it was left as-is — a stronger treatment than a dot, not a gap.
>    Native `<select>`/`<datalist>` category inputs (the ledger "Add transaction" form,
>    `LedgerRowCard`'s inline edit) can't render a coloured swatch inside `<option>` cross-browser,
>    so those were deliberately left alone.
> 2. **Settings sub-navigation — done.** New `SettingsSubNav.tsx`, a sticky (`top-14`, below the
>    global header) pill nav for the 8 sections the checkpoint named. Added the 3 missing anchor ids
>    it needed (`categories` on `AccountsForm.tsx`'s Categories card, `rules` on
>    `SettingsCategoryBridge.tsx`'s Patterns card, `danger-zone` wrapping `<DangerZone />` in
>    `settings/page.tsx`) — `accounts`/`budgets` already existed from #12's own review fix. Active
>    section tracks scroll position via each target's `getBoundingClientRect().top` on a scroll
>    listener rather than `IntersectionObserver`: an observer with a narrow top-of-viewport band goes
>    stale while scrolled through an *untracked* section (Preferences, Reconciliation — neither is
>    part of the named 8 and has no anchor id), since nothing tracked intersects the band there: the
>    walk-every-section approach always finds the last one reached, gap or not. Every anchor target
>    also got `scroll-mt-24` so the anchor-scroll lands below the sticky header + sub-nav instead of
>    under it.
>
> **Verified:** `tsc --noEmit`, `npx eslint app lib` (31 problems — unchanged baseline), and
> `npm run test:run` (146/146) all clean. Screenshotted with Playwright (installed ad hoc, not added
> to `package.json` — same pattern PR #10 used for `@axe-core/playwright`) against seeded test data:
> confirmed the category dot renders in the ledger row, the category filter dropdown, the inline-edit
> `Select`, and the row-edit `TYPE`/`CATEGORY` selects; confirmed the sub-nav's active pill tracks
> scroll position correctly through the Preferences/Reconciliation gaps and that clicking a pill lands
> the target section below the sticky chrome, not under it.

### Phase U6 — Visual polish & performance of the UI itself ✅ (M7b)

- Convert the 9 `.ttf` fonts to `.woff2` and drop unused IBM Plex Mono weights (keep 400/500/600);
  `next/font/local` supports woff2 directly. Cuts several hundred KB from first load.
- Normalize the radius scale to the Design Guide's (4 / 6 / 8 / 12 / pill) and icon sizes to a
  small set (12 / 14 / 16 / 20 / 28) during U1 migration — no separate pass, just enforce in the
  primitives.
- Table density option (comfortable/compact) in the ledger — nice-to-have, last.
- Chart theming: read tick/grid colors from CSS vars instead of the `isDark` MutationObserver
  state in `DashboardView` (the observer can stay for Recharts props if needed, but prefer
  CSS-var-driven `stroke`/`fill` so charts re-theme without a re-render).
- Verify: Lighthouse (production build) — a11y score ≥ 95, no layout shift from fonts
  (`font-display: swap` already set), total font transfer < 200 KB.

> **M7b status:** done. **Fonts:** all 9 `.ttf` files converted to `.woff2` via `fontTools`
> (`flavor = 'woff2'`); IBM Plex Mono trimmed from 7 weights to 3 (400/500/600 — Thin,
> ExtraLight, Light, Bold deleted). `app/layout.tsx`'s `next/font/local` declarations updated to
> point at the woff2 files with the trimmed weight list; `display: 'swap'` was already set and
> untouched. Total font payload: 1,143,200 B (9 `.ttf`, ~1.09 MiB) → 196,020 B (5 `.woff2`,
> ~191 KiB) — an 83% reduction, confirmed under the 200 KB target by measuring the actual
> `/_next/static/media/*.woff2` transfer sizes off a production build. **Radius:** added a
> `--radius-xs/sm/md/lg/pill` (4/6/8/12/9999px) scale to `globals.css` and pointed the shared
> primitives (`.card`, `.btn`, `.ui-input`, `.ui-modal-content`, `.skeleton`, `Select.tsx`,
> `Badge.tsx`, the global `:focus-visible` rule) at it instead of hardcoded px; the one true
> off-scale outlier found (`BackupManager`'s `rounded-[5px]`) was fixed to the 6px token. The
> remaining ad hoc `rounded-[Npx]` call sites across ledger/dashboard/settings already matched
> the 4/6/8 scale numerically, so per the plan's "does not need to be exhaustive" they were left
> as-is rather than swept file-by-file. **Icon sizes:** normalized every off-scale
> `size={9|10|11|13|15|18}` lucide prop across the primitives, nav, and ledger/dashboard/settings
> screens to the 12/14/16/20/28 set (9/10/11→12, 13→14, 15→16, 18→20); a handful of large
> decorative/illustration icons in upload/chat success states (22/32/36/40) were left alone as
> out-of-scope for a "no redesign" pass. **Chart theming:** `DashboardView.tsx`,
> `CategoryTrendChart.tsx`, and `NetWorthWidget.tsx` no longer branch tick/grid/cursor/tooltip
> colors on an `isDark` MutationObserver state — added `--chart-tick`/`--chart-grid`/
> `--chart-cursor` tokens (light + `.dark` override) to `globals.css` and pass them directly as
> Recharts `stroke`/`fill` strings; the dashboard's account-balance gradient fade (the other
> `isDark` consumer) now reads `var(--bg-page)` instead. All three files' `isDark` state,
> `useEffect`, and `MutationObserver` were removed entirely — not just left dormant — since
> nothing remaining needed a JS-level re-render for color. **Table density:** added a
> comfortable/compact toggle button next to Export in `LedgerView`'s desktop table header
> (`Rows2`/`Rows3` icons), persisted to `localStorage` (`ledgerDensity`, same pattern as the theme
> toggle); compact mode applies a `.ledger-table-compact` class picked up by a `td`/`th` CSS rule
> in `globals.css` that tightens vertical padding and font-size without threading a density prop
> through `LedgerRow`. **Verify:** `npm run lint && npm run test:run && npm run build` all green
> (the pre-existing lint errors/warnings in `guide`/`upload`/`RecurringTransactions`/
> `SettingsCategoryBridge` are unchanged from `main`, confirmed via `git diff --stat origin/main`
> on those files). No Lighthouse CLI was available in this sandboxed environment, so a11y ≥ 95
> wasn't measured numerically here; instead verified manually via Playwright (Chromium) headless
> screenshots of `/dashboard`, `/ledger`, `/settings` in both light and dark mode — layout,
> spacing, and theme all render correctly with no visual regression — plus confirmed
> `font-display: swap` survived in the built CSS and the woff2 files are actually served
> (`/_next/static/media/*.woff2`, verified via `curl`).

---

## 4. Explicit non-goals

- No auth/multi-user (LAN-only by design; do not add login flows).
- No cloud sync, no bank API integrations (Plaid etc.).
- No migration off SQLite/Prisma; no framework/library swaps; no visual redesign — the warm
  Cursor-inspired identity stays. Follow `Design Guide.md` for any new UI; the only intentional
  visual changes are the ones enumerated in Phase U1.5 (action hierarchy, token fixes).
- Do not change the money-in-cents convention or the sign/type rules in `lib/accounts.ts`.
- Do not weaken the read-only SQL guard (`lib/prisma.ts`) — extend its tests when touching it.

## 5. Suggested execution order & checkpoints

Tech phases (0–8) and UX phases (U1–U6) interleave. U1/U1.5 (design-system primitives + tokens)
land as their **own PR before** the Phase 1 ledger rework: they touch the same components, but a
pure pixel-identical-except-U1.5 refactor and a data-flow rewrite are much easier to review
separately, and Phase 1 then builds on the primitives. Mobile (U3) rides with M4 — it's a
confirmed requirement (phone-on-the-couch is a primary usage mode), so it shouldn't wait behind
the Phase 6 data-integrity work; its only hard dependency is U1's primitives. U4's `loading.tsx`
work lands with Phase 2 so slow-page feedback and fast pages arrive together.

| Milestone | Contains | Definition of done |
|---|---|---|
| M1 | Phase 0 | Migrations committed; WAL on; prod-mode deploy; index added; build green; **0.5 baseline numbers recorded at the top of this file** |
| M2a | U1 + U1.5 | UI primitives in place; token gaps filled (transfer amber, overlay, focus ring); JS hover handlers gone; screens pixel-identical except enumerated U1.5 changes |
| M2b | Phase 1 | Ledger server-driven; 50k-row seed feels instant vs. 0.5 baseline; stats match old values; currency bug fixed |
| M3 | Phase 2 + 3 + U4 | Dashboard SQL aggregates with oracle test; refetch storm, rule counts, dup-check, SQL cap, timeouts fixed; toast system replaces every `alert()`/silent catch; `loading.tsx` on all routes; upload format-override chip; chat stop button |
| M4 | Phase 4 + 5 + U3 | Guide off the bundle; undo-delete; settings-driven models (defaults + advanced override); structured extraction validated against the configured model; chunked parsing; mobile nav, ledger cards, chat drawer — usable at 390px |
| M5 | Phase 6 + U2 | createdVia + safe deletes; CHECK constraints (follow-on migration, pre-checked against live data); bulk reimbursement suggestions; Radix Dialog modals; aria labels; keyboard-visible row actions; reduced-motion + system theme |
| M6 | Phase 7 (items 1–4 min) + U5 | CSV import; reconciliation; restore; net-worth history; Dashboard in nav; ledger date filter + presets; unified money/date formatting; category color dots; settings sub-nav; empty states; first-run card |
| M7 | Phase 8 + U6 | Seed, tests, CI, ops docs; woff2 fonts; Playwright viewport sweep + axe checks; Lighthouse a11y ≥ 95 |

Each milestone should be a separate PR-sized change with `npm run lint && npm run test:run && npm run build` green before moving on.

### Choosing an implementer per phase

Not every phase needs the same horsepower. If work is delegated to models of different strengths:

- **Mechanical — a lighter/faster model is fine:** 0.1 baseline migration, 0.3 docs/systemd, 0.4
  index, U6 font conversion, U4 toast plumbing and `loading.tsx` skeletons, U5 formatting
  unification, Phase 8 seed script and CI wiring, the U1 *migration* of components onto
  already-built primitives.
- **Judgment-heavy — use the strongest model available, and review its diff:** Phase 1 and
  Phase 2 (correctness-preserving rewrites of the aggregation semantics — the split/reimbursement
  exclusion rules are subtle and the oracle test must be written *before* the old code is
  deleted), the 6.2 CHECK-constraint table-rebuild migration (data-destructive if wrong),
  designing the U1 primitive APIs and U1.5 tokens (one-time decisions everything else inherits),
  and Phase 5's structured-output validation (requires honest experimentation, not assumption).
- Regardless of model: no milestone merges without the verify steps in its phases actually run.
