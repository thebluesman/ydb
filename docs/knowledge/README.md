# `docs/knowledge/` — chat knowledge snippets

Deliverable for chat-knowledge ticket 3. Owned by `@product-manager`; consumed at runtime by the chat
pipeline.

**This directory is application input, not documentation.** Everything else under `docs/` is written
for humans. These files get read by code and pasted into a model prompt. Editing a file here changes
what the assistant says. Treat changes the way you'd treat changes to `app/api/chat/route.ts` — branch
and PR, not a direct push to `main` — even though the rest of `docs/` is fine to commit directly per
AGENTS.md § Git workflow.

## What's here

25 knowledge snippets, one per file. They give the local model (Ollama, per ADR-0006) enough shared
budgeting vocabulary to narrate ledger rows without inventing framing. They are general personal-finance
concepts only — no user data, no account details, nothing YDB-specific.

Content came from `docs/chat-knowledge-content-outline.md` (ticket 1, topic selection) and
`docs/chat-knowledge-content.md` (ticket 2, drafting + the length decision and the two UAE corrections).
Those two files stay as the reasoning record. **The files in this directory are canonical for snippet
text** — if they disagree with the ticket-2 draft, these win.

## Location, and why not somewhere else

`docs/knowledge/`, because AGENTS.md § Output format rule puts every agent deliverable in `docs/` as
markdown, and these are agent deliverables that happen to also be runtime input. `lib/` or a `.ts`
constant would have made them code, which invites editing prompt prose in a code review context and
loses the ability to hand a file to `@tech-lead` or `@qa` as a reviewable unit. A directory of markdown
files with front-matter keeps both properties: greppable and diffable by hand, trivially loadable by a
few lines of code.

## File convention

**Naming:** `<id>-<kebab-slug>.md`, e.g. `d1-avalanche-vs-snowball.md`.

The `id` prefix (`a1`, `d4`, `x1`) is an **identifier, not an ordering** — it exists so a file can be
matched one-to-one against a row in the ticket-1 outline and the ticket-2 draft, which is the only way
to tell whether the three documents still agree. Do not renumber to reorder; ordering has no meaning
here. New snippets take the next free number in their area (or a new area letter).

**Structure:** YAML front-matter, then the snippet text, then optional human-only notes.

```markdown
---
id: D1
title: "Avalanche vs snowball"
area: debt
priority: P0
status: active
words: 67
keywords: ["payoff order", "avalanche", "snowball", "which debt first"]
verified: 2026-07-29
sources:
  - https://rulebook.centralbank.ae/en/entiresection/4406
---

Paying the highest interest rate first costs the least; …

## Notes (not injected)

CBUAE caps early settlement at 1% of outstanding principal or AED 10,000, whichever is lower. …
```

### The injection rule

**Injected text is the body from the end of the front-matter up to the first `##` heading.** Everything
from the first `##` onward is human-only commentary and must never reach the prompt.

This is the whole parse contract. It's deliberately dumber than it could be: one delimiter, no nesting,
no per-file special cases. Notes exist because several snippets carry sourcing and reasoning that a
reviewer needs and the model must not read — putting that in a comment field would have meant
hand-wrapping prose inside YAML.

### Front-matter fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | `[A-F\|X]<n>` | Stable identifier. Matches the outline and draft docs. Never reused after deletion. |
| `title` | yes | string | Human label. Not injected — the model gets the prose, not the heading. |
| `area` | yes | enum | One of `envelope-foundation`, `frameworks`, `cash-flow-hygiene`, `debt`, `reserves`, `review-habits`, `boundary`. |
| `priority` | yes | `P0` \| `P1` \| `P2` | Injection tier. See below. |
| `status` | yes | `active` \| `held` | `held` = drafted and reviewed but **must not be injected yet**. |
| `words` | yes | int | Word count of the injected body. 40–70 target, 80 hard cap. |
| `keywords` | yes | list of strings | Lowercase phrases a user question might contain. Ticket 4's matcher input if it ends up needing one. |
| `verified` | when `sources` present | ISO date | When the sourced claims were last checked. |
| `sources` | no | list of URLs | Required for any snippet asserting a jurisdiction-specific fact. |

### Priority tiers

- **P0 (12 snippets, 737 words, ~950–1,000 tokens)** — the baseline set. Ticket 2's sizing was done so
  that injecting all of P0 on every narration call is affordable, which means no retrieval layer is
  needed to ship.
- **P1 (10)** — drafted and ready. The cheapest way to spend measured headroom is adding these, not
  lengthening existing snippets. If the budget forces cuts among P1, `E2` and `E3` survive ahead of the
  B and F rows.
- **P2 (3: `D4`, `F2`, `F3`)** — all currently `status: held`. Do not inject until ticket 4 measures real
  token cost. `D4` is not purely optional the way `F2` and `F3` are: it carries the "borrowing is priced
  in more than one way" point that stops the model narrating a flat-rate instalment loan with
  revolving-card logic. If `D4` stays held, fold that clause into `D3` or `D1` rather than losing it.

`priority` and `status` are separate on purpose. Priority is *how important*; status is *cleared to ship
or not*. A P0 snippet could go `held` pending review without being demoted, and the P2 hold can be
lifted by measurement without a priority edit.

### Word budget

40–70 words, 2–4 sentences, hard ceiling 80. Full reasoning is in `docs/chat-knowledge-content.md`
§ "Target snippet length". Short version: the design injects the whole P0 set at once, so snippet length
multiplies by 12 and competes directly with the ledger rows the model is supposed to be interpreting.
Below 40 words the snippets degrade into slogans that paraphrase badly.

Counts in `words:` are recomputed mechanically (whitespace tokens, punctuation-only tokens like standalone
em dashes discarded) and run 1–4 words above a few of ticket 2's hand counts. The mechanical count is
authoritative going forward.

## Rules for editing

1. **One idea per file.** If a snippet wants more than 70 words, it's two snippets, not a long one.
2. **No user data, no account names, no balances, no numbers from the ledger.** These files are general
   knowledge. Anything specific to Shyam's finances belongs in the ledger, not in the prompt preamble.
3. **Ledger data wins.** Snippets supply vocabulary and framing. They never override, contradict, or
   substitute for what the query returned. A snippet that would make the model assert something the rows
   don't support is a bug.
4. **Jurisdiction-specific claims need `sources` + `verified`.** Sections D and E were web-verified for
   UAE context and two of the outline's assumptions turned out to be wrong (see
   `docs/chat-knowledge-content.md` § "Corrections to the outline's UAE notes"). Rates, caps, and
   statutory schemes drift — re-check anything older than about a year before trusting it.
5. **Prefer naming the factor over naming the country.** "Residency tied to employment" rather than "in
   the UAE" — it keeps the snippet correct if circumstances change and avoids the model asserting
   location facts it can't verify.
6. **`X1` always ships.** The boundary snippet is P0 by function, not topic: it's the only snippet whose
   absence changes *what* the assistant will say rather than how well it says it. Any priority filtering
   ticket 4 lands on must exempt it.
7. **Update `words:` when you edit the body.** It's the budget's only checkable record.

## What this directory does not touch

Adding knowledge to the prompt changes the narration path, not the query path. The read-only SQL guard
in `lib/prisma.ts` (`docs/architecture.md`) is unaffected and stays as-is — a loader here reads markdown
files off disk and concatenates strings. Ticket 4 wires the loader into `app/api/chat/route.ts` and
**needs `@tech-lead` sign-off**, because that route is on the guarded path even if this directory isn't.

Also unaffected: integer-cents money and the sign rules in `lib/accounts.ts`. Nothing here computes.

## Would this convention extend to open-ended ingestion?

There's a separate, unscoped Notion ticket — "[chat-knowledge] Scope a knowledge-base ingestion pipeline
(Karpathy LLM-Wiki-style)" — for an ongoing ingestion mechanism rather than this closed 25-snippet set.
It flags storage-convention overlap with this ticket. Noting the fit here so whoever picks it up has a
starting point. This is *not* a commitment that ingested content lands in `docs/knowledge/`.

**What carries over:**

- Markdown + YAML front-matter as the storage format. It's the same shape every ingestion tool already
  emits, and it stays hand-editable.
- `priority`/`status` as separate axes, and `sources`/`verified`. An ingestion pipeline needs provenance
  and a staging state more than this set does, not less.
- The "body up to the first `##`" injection rule works for any single-chunk document.

**What would need rework:**

- **Curation model.** Every file here was hand-written to a word budget and reviewed. Ingested content is
  neither. Ingested docs want a different directory (`docs/knowledge-ingested/` or outside `docs/`
  entirely) so that "reviewed prompt content" and "scraped material" never get injected by the same
  glob. Do not let ingestion write into this directory.
- **Retrieval.** This set is small enough to inject whole. That's the assumption the whole convention
  rests on — no index, no embeddings, no chunking, `keywords` as a hand-written escape hatch. An
  open-ended corpus inverts that: retrieval becomes mandatory, `keywords` doesn't scale, and the metadata
  a retriever wants (embeddings, chunk ids, source doc, ingest date, checksum) is a superset of this
  schema, not the same schema.
- **The word budget.** 40–70 words per file is a *human-authored* constraint that exists because 12
  snippets go in on every call. It's meaningless for chunked source material.
- **Sizing per file.** One idea per file holds only when a person wrote the file.

Read as: same format, different directory, different retrieval story. The schema here is a reasonable
subset to start from — it isn't a foundation that ingestion can build on top of unchanged.

## Ticket trail

| Ticket | Deliverable |
|---|---|
| 1 — research/outline | `docs/chat-knowledge-content-outline.md` |
| 2 — content draft | `docs/chat-knowledge-content.md` |
| 3 — storage + convention | this directory (README + 25 snippet files) |
| 4 — loader/injection | not started; needs `@tech-lead` sign-off |
