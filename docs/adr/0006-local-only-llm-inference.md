# ADR-0006: All LLM inference stays local

Status: Accepted
Date: 2026-07-29

## Context

YDB has driven an LLM since before the migration project. Chat (`app/api/chat/route.ts`) does
text-to-SQL and then narrates the result rows; statement extraction (`app/api/ollama/route.ts`,
`app/upload/`) reads statement text into structured transactions. Both are raw `fetch` calls to an
Ollama `/api/generate` endpoint. There is no provider abstraction, no `ai` package, no hosted API key
anywhere in the tree. `lib/llm-config.ts` resolves the endpoint and model per request as
Setting → env → shipped default (`lib/llm-models.ts`: `qwen2.5:32b` for chat, `qwen2.5-coder:14b` for
extraction), and `OLLAMA_URL` can point at a separate GPU box on the LAN.

So the app has a zero-egress property for financial data: transaction rows, query results, and the
questions Shyam types never leave the LAN. That property has never been written down. It has only
ever been an accident of the code that happens to be there — nothing stops a future change from
adding a hosted call.

It is also load-bearing for reasoning already recorded elsewhere. ADR-0001 calls YNAB "YDB's first
external API dependency" and trades away "zero external dependencies" as a bounded, temporary cost.
That framing is only true because the LLM path is local. If chat called a hosted model, YNAB would
be neither the first nor the most sensitive external dependency, and ADR-0001's cost/benefit would
have been argued on false premises.

A brainstorm about using local models more deliberately surfaced a specific idea worth deciding on
now rather than later: a hosted fallback that handles queries the local model fumbles.

## Decision

All LLM inference for YDB runs on a self-hosted runtime (Ollama, or an equivalent process Shyam
runs) reachable on localhost or the LAN. No transaction data, query result, statement text, or user
question is sent to a hosted or third-party inference API. This covers both the chat/SQL path and
the extraction path.

The "hosted fallback for complex queries" idea is rejected for now. The narration prompt embeds real
transaction rows, so a fallback ships actual ledger data off the LAN; even a fallback limited to SQL
generation ships the question text, which is itself query intent about Shyam's finances. The gain is
unmeasured — there is no eval harness showing local models are insufficient at the queries Shyam
actually asks. Trading a categorical privacy property for an unquantified quality gain is the wrong
order of operations. Build the eval harness first; if it shows a real gap, that is grounds for a
superseding ADR, not for a quiet fallback branch.

Pointing `OLLAMA_URL` at another machine Shyam controls is in scope. Pointing it at a rented
inference endpoint is not, and neither is an Ollama-compatible proxy that forwards to one.

## Consequences

- Chat quality is capped by what fits on the hardware. Accepted: bad answers are recoverable,
  leaked ledger data is not.
- ADR-0001's "first external dependency" framing now rests on a stated invariant rather than an
  implicit one, which makes the YNAB integration's removal story (ADR-0001) actually return the app
  to zero standing external dependencies.
- Adding hosted inference now requires an ADR superseding this one, which is the point.
- An eval harness for the chat path becomes the prerequisite for revisiting this. None exists today;
  that is a known gap, not a blocker for Phase 1.
