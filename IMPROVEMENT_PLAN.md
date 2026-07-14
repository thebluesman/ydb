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

### Phase 1 — Ledger: move filtering/pagination to the server (biggest win)

The ledger currently ships the whole table to the client and keeps a mutable copy in React state.
Replace with a server-driven table. Target: `/ledger` responds in <200 ms and transfers <100 KB
with 50k rows in the DB.

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
- Verify: dashboard totals unchanged on the existing DB (snapshot values before/after), page render
  under 150 ms with the 50k-row seed.

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

### Phase 4 — Client rendering cleanups

- **Guide:** remove `'use client'` from `GuideView.tsx` (extract any interactive bits into small
  client leaf components) so 1,500 lines of static JSX render on the server and leave the bundle.
- **Ledger:** done in Phase 1 (memo + debounce). Also replace `alert()`/`confirm()`
  (`LedgerView.tsx:246`, `LedgerRow.tsx:266`) with an inline confirm popover and a toast component;
  add "Undo" to delete by keeping the deleted row payload client-side and re-POSTing on undo (5 s
  window) — cheaper than soft-delete and good enough for home use.
- **Chat:** `bottomRef.scrollIntoView({behavior:'smooth'})` on every token causes jitter — scroll
  instantly while streaming, and only if the user is already near the bottom.
- **Dashboard:** memoize chart data transforms if profiling shows re-render cost; otherwise leave.

### Phase 5 — LLM pipeline quality

- **Settings-driven config (fixes the README lie).** Add Settings keys `ollamaUrl`,
  `extractionModel`, `chatModel` (UI in `PreferencesForm.tsx`, dropdown populated from
  `${ollamaUrl}/api/tags` via a small proxy route). Both LLM routes read the Setting first, env var
  as fallback, current defaults last. Cache the setting lookup per request only (no global cache —
  it can go stale).
- **Structured extraction.** In `app/api/ollama/route.ts` pass Ollama's structured output
  (`format: { type: 'array', items: {...} }` — check the Ollama docs for the JSON-schema `format`
  parameter) so the model must emit valid JSON. Keep the salvage parser as fallback for models that
  ignore `format`. Remove the `'['` assistant-priming hack when `format` is used.
- **Chunk long statements.** In `UploadFlow.tsx`, if extracted text exceeds ~12 KB, send one
  request per page (the page loop already yields per-page text) and concatenate the parsed arrays.
  Show "page 2/5" in the parse log. This keeps well inside `num_ctx` and improves accuracy.
- **SQL retry loop.** In `app/api/chat/route.ts`, when `executeReadonlyQuery` throws a SQLite error,
  send one repair round-trip to the model ("The query failed with: <error>. Return a corrected
  SQLite SELECT.") before surfacing the error. One retry max.

### Phase 6 — Data integrity (implements FOLLOWUPS.md)

- **6.1 Soften transfer delete cascade** (FOLLOWUPS §2): add `createdVia String @default("import")`
  to Transaction (migration + set `'manual'` in `/api/transactions/manual` and the counterpart
  creation paths). `DELETE /api/transactions/[id]`: cascade to the counterpart only when the
  counterpart's `createdVia === 'manual'`; otherwise unlink (null both pointers) and delete only the
  requested row. Return `{ deletedCounterpart: boolean }` so the UI can message accurately.
- **6.2 DB constraints** (FOLLOWUPS §5): in the next migration add
  `CHECK ((transactionType = 'debit' AND amount <= 0) OR (transactionType = 'credit' AND amount >= 0) OR transactionType = 'transfer')`
  via raw SQL in the migration file (Prisma schema can't express CHECK; write it as
  `CREATE TABLE ... ` table rebuild or `ALTER TABLE` per SQLite rules — a table rebuild migration is
  the reliable route). Also switch split legs to `onDelete: Cascade` on `parentTransaction`.
- **6.3 Bulk reimbursement linking** (FOLLOWUPS §1): in the ledger pending-reimbursements view, add
  "Suggest matches": `GET /api/reimbursements/suggest` pairs each unlinked `reimbursableFor` expense
  with candidate credits (same currency, amount within ±1%, date after expense, category
  `Reimbursement` or description similarity) and the user confirms each. Reuse the existing
  `/api/transactions/[id]/reimburse` link endpoint per confirmation.
- **6.4 Category referential tidiness:** `PATCH /api/transactions/bulk` and single PATCH should
  warn (not reject) when `category` doesn't exist in the Category table; ledger currently lets
  arbitrary strings in, which then don't appear in Settings. Cheapest fix: auto-create the category
  (with palette color) on first use, matching the CategoryManager behavior.

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

### Phase U2 — Accessibility pass

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

### Phase U3 — Responsive / mobile

Target: fully usable on a ~390px phone; comfortable on tablet.
- **Nav:** collapse to a hamburger (Radix `DropdownMenu` or a simple disclosure) below `md`;
  include Dashboard (see U5) and Settings in the collapsed menu.
- **Ledger:** stat cards `grid-cols-1 sm:grid-cols-3`; below `md`, render rows as stacked cards
  (date + description + amount + badges, actions in an overflow menu) instead of the wide table —
  a `LedgerRowCard` sibling component sharing the same handlers; bulk bar becomes full-width
  bottom sheet; filters collapse into a "Filters" disclosure showing active-filter chips.
- **Chat:** sidebar becomes a slide-over drawer below `md` with a sessions button in the header.
- **Dashboard:** chart grids stack to one column; filter bar wraps (already `flex-wrap` — verify
  the `ml-auto` date group behaves); balances rail already scrolls horizontally (keep).
- **Settings/Upload/Review:** review-table rows already wrap; verify at 390px and fix overflow.
- Verify: Playwright viewport sweep (390/768/1280) screenshotting each page; no horizontal page
  scroll at any width.

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

### Phase U6 — Visual polish & performance of the UI itself

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

Tech phases (0–8) and UX phases (U1–U6) interleave: do U1/U1.5 alongside the Phase 1 ledger
rework (both rewrite the same components — doing them together avoids touching LedgerView twice),
and U4's `loading.tsx` work lands with Phase 2 so slow-page feedback and fast pages arrive
together.

| Milestone | Contains | Definition of done |
|---|---|---|
| M1 | Phase 0 | Migrations committed; WAL on; prod-mode docs; index added; build green |
| M2 | Phase 1 + U1 + U1.5 | Ledger server-driven; 50k-row seed feels instant; stats match old values; currency bug fixed; UI primitives in place; token gaps filled (transfer amber, overlay, focus ring); JS hover handlers gone from migrated components |
| M3 | Phase 2 + 3 + U4 | Dashboard SQL aggregates with oracle test; refetch storm, rule counts, dup-check, SQL cap, timeouts fixed; toast system replaces every `alert()`/silent catch; `loading.tsx` on all routes; upload format-override chip; chat stop button |
| M4 | Phase 4 + 5 + U2 | Guide off the bundle; undo-delete; settings-driven models; structured extraction; chunked parsing; Radix Dialog modals; aria labels; keyboard-visible row actions; reduced-motion + system theme |
| M5 | Phase 6 + U3 | createdVia + safe deletes; CHECK constraints; bulk reimbursement suggestions; mobile nav, ledger cards, chat drawer — usable at 390px |
| M6 | Phase 7 (items 1–4 min) + U5 | CSV import; reconciliation; restore; net-worth history; Dashboard in nav; ledger date filter + presets; unified money/date formatting; category color dots; settings sub-nav; empty states; first-run card |
| M7 | Phase 8 + U6 | Seed, tests, CI, ops docs; woff2 fonts; Playwright viewport sweep + axe checks; Lighthouse a11y ≥ 95 |

Each milestone should be a separate PR-sized change with `npm run lint && npm run test:run && npm run build` green before moving on.
