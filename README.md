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

## Models

ydb drives Ollama for two distinct jobs, each configurable in **Settings → Preferences → Local
models**. The picker is defaults-first: each role shows a recommendation, and an **Advanced**
disclosure lists your installed models (annotated) if you want to change them.

| Role | Setting key | Default | Why |
|------|-------------|---------|-----|
| **Extraction** | `extractionModel` | `qwen2.5-coder:14b` | Reads statement text into a structured transaction array. This model reliably honours Ollama's structured-output (`format`) constraint — verified against real statement text — and fits modest VRAM. |
| **Chat / SQL** | `chatModel` | `qwen2.5:32b` | Generates SQLite from natural language. The 32b is the most accurate here; drop to `qwen2.5-coder:14b` if the box is short on memory. |

Resolution precedence per role is **Setting → environment variable → shipped default**, so an
un-configured install still works out of the box:

- `OLLAMA_URL` (default `http://localhost:11434`) — override with the `ollamaUrl` setting
- `OLLAMA_MODEL` — extraction model fallback
- `CHAT_MODEL` — chat/SQL model fallback

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
