# ydb

A personal finance tracker with AI-powered natural language querying. Import bank statements, categorise transactions, track budgets, and ask questions about your spending in plain English — all running locally.

> **Working on ydb?** Read [`IMPROVEMENT_PLAN.md`](IMPROVEMENT_PLAN.md) first — it's the full code/product/UX review and the phased roadmap (performance fixes, design-system work, feature milestones M1–M7). New work should follow the plan's order and respect its non-goals.

## Features

- **Multi-account support** — current accounts, credit cards, personal loans, and auto loans
- **Statement import** — parse PDF bank statements via PDF.js and OCR (Tesseract.js)
- **Transaction management** — review, commit, and reconcile transactions; split transactions and link transfers between accounts
- **Auto-categorisation** — define vendor rules that automatically assign categories based on transaction description
- **Budgets** — set monthly spending limits per category
- **Dashboard** — visual spending summaries and charts
- **AI chat** — ask natural language questions about your finances; powered by a local Ollama model via Text-to-SQL

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 / React 19 |
| Database | SQLite via Prisma + better-sqlite3 |
| Styling | Tailwind CSS v4 |
| Components | Radix UI |
| Charts | Recharts |
| PDF parsing | PDF.js |
| OCR | Tesseract.js |
| AI | Ollama (local LLM) |

## Prerequisites

- Node.js 20+
- [Ollama](https://ollama.com) running locally with the two models below pulled:

  ```bash
  ollama pull qwen2.5-coder:14b   # statement extraction
  ollama pull qwen2.5:32b         # chat / Text-to-SQL
  ```

  See [Models](#models) for why these two and how to change them.

## Getting Started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Set up the database**

   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```

3. **Build and start the app**

   ```bash
   npm run build && npm run start
   ```

   The app runs on [http://localhost:3333](http://localhost:3333). This is the primary way to
   run ydb on a home server — `next start` is meaningfully faster than `next dev` and is what the
   sample systemd unit in [`deploy/ydb.service`](deploy/ydb.service) uses.

### Development

For local development with hot reload:

```bash
npm run dev
```

This also runs on [http://localhost:3333](http://localhost:3333).

## Project Structure

```
app/
  dashboard/     # Spending overview and charts
  ledger/        # Transaction list and management
  upload/        # Bank statement import
  chat/          # AI natural language Q&A
  settings/      # Accounts, categories, budgets, vendor rules
  guide/         # In-app help
prisma/
  schema.prisma  # Database schema
```

## AI Chat

The chat feature uses a two-step Text-to-SQL pipeline:

1. Your question + the database schema are sent to Ollama, which generates a SQL query
2. The query result is sent back to Ollama, which narrates a plain English answer

Each response includes a "Show SQL" toggle so you can verify the query that produced the answer.
If a generated query fails, the app sends the model one repair round-trip (the failed query + the
SQLite error) before surfacing the error to you.

> **Note:** The AI chat requires Ollama to be running locally.

## Home server

ydb is designed to run continuously on a home server (LAN-only, no auth — see the "Explicit
non-goals" in `IMPROVEMENT_PLAN.md`). This section covers the pieces of that setup beyond the
`npm run build && npm run start` instructions above: running as a systemd service, configuring
`OLLAMA_URL`, and — most importantly — backing up the database correctly.

### Running as a systemd service

A sample unit is checked in at [`deploy/ydb.service`](deploy/ydb.service):

```bash
sudo cp deploy/ydb.service /etc/systemd/system/ydb.service
sudo systemctl daemon-reload
sudo systemctl enable --now ydb
```

It runs `npm run start` (production `next start`, not `next dev`) out of `WorkingDirectory`, with
`Restart=on-failure` and `KillMode=mixed` (a plain `SIGTERM` to `npm` doesn't reliably stop the
`next` child process it spawns — see the comments in the unit file). Build the app once before (or
after) enabling the service: `npm ci && npx prisma migrate deploy && npm run build`. Adjust `User`,
`WorkingDirectory`, and the `npm` path (`which npm` on the target box — nvm-managed Node installs
often aren't at `/usr/bin/npm`) for your setup.

### `OLLAMA_URL`

By default ydb talks to Ollama at `http://localhost:11434`. If Ollama runs on a different host or
port (e.g. a separate GPU box on the LAN), set the `OLLAMA_URL` environment variable — or the
`ollamaUrl` Setting from **Settings → Preferences → Local models**, which takes precedence (see
[Models](#models) below for the full resolution order). For the systemd unit, uncomment the
`EnvironmentFile` line and put `OLLAMA_URL=http://<host>:11434` in that file, or add an
`Environment=OLLAMA_URL=...` line directly.

### Backups

`Settings → Backups` creates on-demand snapshots, and `instrumentation.ts` runs one automatic daily
backup on startup (skipped if a backup already exists from today). Backups are written to the
`backups/` directory as `ydb-<timestamp>.db` files, with the 14 most recent kept
(`lib/backup.ts` `MAX_BACKUPS`).

**Back up `dev.db` through the app (or `lib/backup.ts`'s `createBackup()`), not with a naive file
copy — and if you ever do copy files directly, copy the WAL sidecars too.** Since Phase 0.2, ydb
runs SQLite in `journal_mode = WAL`. In WAL mode, committed writes are appended to a separate
`prisma/dev.db-wal` file and only periodically folded back (`checkpoint`ed) into `prisma/dev.db`
itself; `prisma/dev.db-shm` is the shared-memory index over that WAL file. That means:

- **`cp prisma/dev.db /somewhere/backup.db` alone can silently lose recent transactions** — anything
  written since the last checkpoint lives only in `dev.db-wal`, which a plain copy of `dev.db`
  doesn't include. The database file on its own is not a complete, consistent snapshot in WAL mode.
- If you must copy files by hand instead of using the app, copy all three together —
  `dev.db`, `dev.db-wal`, and `dev.db-shm` — from a moment when no writer is active, and be aware
  a plain filesystem copy of a live SQLite database (even all three files) is not guaranteed
  transactionally consistent if a write lands mid-copy.
- **`createBackup()` (`lib/backup.ts`) avoids all of this correctly**: it opens the source database
  read-only and calls better-sqlite3's `Database#backup()`, which uses SQLite's own online backup
  API — the same mechanism `.backup`/`VACUUM INTO` use — to produce a single self-contained,
  consistent snapshot file regardless of what's currently in the WAL or being written concurrently.
  This is why the app-level backup exists instead of a shell `cp` in a cron job: it's the only way
  to get a correct point-in-time snapshot without stopping the server first.
- **Restoring** (`restoreBackup()`) is WAL-aware too: it explicitly checkpoints the live database
  (`PRAGMA wal_checkpoint(TRUNCATE)`) and removes the `-wal`/`-shm` sidecars before copying the
  snapshot over `dev.db`, so a restored file can't end up shadowed by stale WAL pages left over from
  before the restore.

If you back up the `backups/` directory itself off-box (recommended — e.g. rsync to another
machine), that's safe to do with a plain file copy: each file in there is already the
self-contained, checkpointed snapshot `createBackup()` produced, not a live WAL-mode database.

### Load-testing with the seed script

`npm run seed` (`scripts/seed.ts`) populates the database Phase-0/M1 style: five accounts spanning
every account type in `lib/accounts.ts` (current, savings, credit card, personal loan, auto loan)
and ~48k transactions over 3 years of history, including splits, transfers, and reimbursements. It's
useful for reproducing the dashboard/ledger performance numbers in `IMPROVEMENT_PLAN.md` (§0.5) on
your own hardware, or just for exercising the app with a realistic amount of data. It only ever
touches accounts whose name starts with `[seed] `, so it's safe to run against a database that also
has real accounts — re-running it wipes and regenerates just the seed data.

## Models

ydb drives Ollama for three distinct jobs, each configurable in **Settings → Preferences → Local
models**. The picker is defaults-first: each role shows a recommendation, and an **Advanced**
disclosure lists your installed models (annotated) if you want to change them.

| Role | Setting key | Default | Why |
|------|-------------|---------|-----|
| **Extraction** | `extractionModel` | `qwen2.5-coder:14b` | Reads statement text into a structured transaction array. This model reliably honours Ollama's structured-output (`format`) constraint — verified against real statement text — and fits modest VRAM. |
| **SQL** | `sqlModel` | `qwen2.5:32b` | Generates SQLite from natural language. Runs at temperature 0, off-screen, and can afford to be slow — accuracy is all that matters. The 32b is the most accurate here; drop to `qwen2.5-coder:14b` if the box is short on memory. |
| **Narration** | `narrationModel` | `qwen2.5:32b` | Writes the answer you watch stream in, from rows the query already returned. Speed is felt here, so a smaller model is often the better trade. |

A chat turn uses the last two in sequence: one call to generate the query, one to narrate the
result. They ship as the same model, which is exactly how a single `chatModel` behaved before the
split — set them apart only when you want to.

**If you do set them apart, size the pair to co-reside in VRAM** — roughly 14B + 7B, not 32B + 32B.
Both models load within a single turn, and a box that can only hold one will evict and reload
mid-answer. Requests pin each model with `keep_alive` to avoid the idle-unload case, but nothing can
reserve memory that isn't there.

Resolution precedence per role is **Setting → environment variable → shipped default**, so an
un-configured install still works out of the box:

- `OLLAMA_URL` (default `http://localhost:11434`) — override with the `ollamaUrl` setting
- `OLLAMA_MODEL` — extraction model fallback
- `SQL_MODEL`, `NARRATION_MODEL` — per-role chat fallbacks
- `CHAT_MODEL` — pre-split fallback, still honoured for both chat roles if the per-role ones are unset

A pre-split install that set `chatModel` (or `CHAT_MODEL`) keeps running that model for both chat
roles; nothing needs migrating. Saving either role in Settings supersedes it for that role.

Settings changes take effect on the next request (no restart), since the config is resolved
per-request rather than cached.

### Structured extraction

Extraction requests pass a JSON-schema `format` to Ollama so the model is grammar-constrained to
emit a valid transaction array. This was validated against `qwen2.5-coder:14b` and works reliably;
a brace-walking salvage parser remains as a permanent fallback for the rare malformed stream. Long
statements (>12 KB of text) are sent one page at a time and the parsed arrays concatenated, keeping
every request well inside the model's context window.

## License

Private — all rights reserved.
