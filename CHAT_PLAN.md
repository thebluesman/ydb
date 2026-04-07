# Financial Chatbot Plan

Natural language Q&A over your income/expense/transfer data using Text-to-SQL with Ollama (Gemma 4).

---

## Approach: Two-Step Text-to-SQL

1. **SQL Generation** — send the user's question + schema to Ollama, ask it to produce a SQL query
2. **Narration** — send the query result back to Ollama, ask it to answer the question in plain English

This scales regardless of how many transactions accumulate, and is more reliable than stuffing raw rows into context.

---

## New Files

### `app/chat/page.tsx`
- Simple chat thread UI (user messages + assistant responses)
- Streaming response display (reuse pattern from existing Ollama route)
- "Show SQL" toggle per response for sanity-checking answers

### `app/api/chat/route.ts`
Two-phase handler:

**Phase 1 — SQL generation**
- System prompt includes the full Prisma schema (table names, columns, types)
- Instructs model to output raw SQL only, no prose
- Runs the generated SQL via Prisma `$queryRaw`

**Phase 2 — Narration**
- Sends original question + SQL result rows back to Ollama
- Streams a plain English answer to the client

---

## System Prompt (SQL phase)

Key things to include:
- Full schema: `Account`, `Transaction`, `Category` tables with all column names and types
- SQLite dialect note (no `DATE_TRUNC`, use `strftime` instead)
- Instruction to output only a single SQL SELECT statement, no markdown fences
- Example Q&A pairs (few-shot) for date range queries and aggregations

---

## Schema Reference (for system prompt)

```
Account: id, name, accountType, currency, isActive
Transaction: id, date, amount, description, category, accountId, status, notes, rawSource
Category: id, name, color
```

Note: `Transaction.date` is stored as a string in ISO format (`YYYY-MM-DD`). Use `strftime` for date math.

---

## UI Considerations

- Keep it minimal — a text input, send button, and scrollable message thread
- Stream the narration phase so responses feel live
- "Show SQL" expandable section under each assistant message
- Error state if the generated SQL fails to parse or returns no rows

---

## Model Recommendation

Use **Gemma 4 12B or 27B** via Ollama for best SQL accuracy. The 4B is fine for simple lookups but unreliable for multi-step aggregations or date comparisons.

Consider routing the chat API to the **Claude API** instead of Ollama if SQL accuracy becomes an issue — the existing Ollama route can stay for OCR/import parsing.

---

## What to Watch Out For

- **Silent wrong answers**: SQL runs but returns incorrect numbers. The "Show SQL" toggle is your defense.
- **Date math**: SQLite has limited date functions. Explicitly tell the model to use `strftime('%Y-%m', date)` for month grouping etc.
- **Amount sign convention**: Clarify in the system prompt whether expenses are stored as negative numbers or positive — the model needs to know to answer "how much did I spend" correctly.
