# ydb

A personal finance tracker with AI-powered natural language querying. Import bank statements, categorise transactions, track budgets, and ask questions about your spending in plain English — all running locally.

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
- [Ollama](https://ollama.com) running locally with a model pulled (Gemma 4 12B or 27B recommended for best SQL accuracy)

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

3. **Start the development server**

   ```bash
   npm run dev
   ```

   The app runs on [http://localhost:3333](http://localhost:3333).

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

> **Note:** The AI chat requires Ollama to be running locally. Set your preferred model in Settings.

## License

Private — all rights reserved.
