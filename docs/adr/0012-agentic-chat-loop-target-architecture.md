# ADR-0012: The chat pipeline's target architecture is a bounded agentic loop

Status: Accepted
Date: 2026-07-29

## Context

Chat is a single-shot pipeline: one `generateSql` call against a fixed schema prompt, one repair
round-trip on a SQLite *error*, then narration of `JSON.stringify(rows)`. It cannot inspect its own
intermediate result. Nothing between generation and narration asks "is this actually an answer to the
question that was asked".

Three bugs found on 2026-07-29 all have that shape — valid SQL, clean execution, confidently wrong
answer: a guessed category literal matching nothing (ADR-0008), a `SUM(amount)` served as a balance
(ADR-0010), a `UNION` whose second label SQLite discarded (ADR-0011). Each was fixed as a point fix on
the generation side. That was right for each individually and is the wrong strategy in aggregate: the
class is unbounded, and every fix narrows what chat may do rather than making it check its work.

Shyam's own read after testing is that he trusts the ledger and dashboard over chat, and what he wants
is an assistant that fetches what it needs, answers clearly, and says "I don't know" instead of
returning something wrong. Point fixes do not move that.

The binding constraint is ADR-0006: inference is local Ollama only, so loop control runs on whatever
fits the box, not on a frontier model.

**Measured on this install, 2026-07-29** (Ollama 0.30.6): `qwen2.5:32b` reports
`capabilities: ["completion", "tools"]`, and `/api/chat` with a `run_sql` tool definition returned a
well-formed `tool_calls` response in ~7s at `num_ctx` 16384. Tool-calling is available today — it is
not a blocker. Also installed: `qwen3.6:latest`, which additionally reports `thinking`.

## Decision

**The target architecture for chat is a bounded ReAct-style loop over `POST /api/chat` (Ollama's
tool-calling endpoint), replacing the fixed generate→execute→narrate sequence.** The model is given
tools, may call one, sees the real result, and decides to call again or to answer. Point fixes stay,
but are no longer the strategy for chat correctness.

The envelope, which is the part being decided now:

- **The only execution tool is `run_sql`, backed by `executeReadonlyQuery` and nothing else.** One
  guard, one execution path, called N times instead of once (see Consequences).
- **Bounded, not open-ended.** A hard cap on model turns per question, a cumulative row budget across
  all queries in a turn, and a wall-clock ceiling inside the existing `OLLAMA_TIMEOUT_MS` (120s).
  At ~7s per tool-calling turn, a 4-tool-call budget lands near 30–40s of model time plus narration —
  slow for a chatbot, fine for a single-user LAN app where a wrong answer costs more than a slow one.
- **Exhausting the budget is an answer, not an error** — that is ADR-0014, decided separately.
- **Read-only, local, single-user posture is unchanged.** No new network surface; the loop calls the
  same Ollama and the same SQLite file.

Sequencing is deliberately *not* part of this decision — the first phase is not a tool-calling loop at
all. See ADR-0013.

## Consequences

**The read-only guard holds, and matters more.** `executeReadonlyQuery` is input-agnostic — it inspects
the SQL string it is handed and knows nothing about what prompted it — so N calls per turn are exactly
as safe as one. Tool arguments are model-generated strings at the same trust level as today's
`generateSql` output; only the frequency changes. Two properties become load-bearing rather than
incidental: the loop must call the guard and never open a second execution path, and the existing
500-row cap must be joined by a **cumulative per-turn row budget**, since four capped queries are 2,000
rows of context the single-shot path could never produce.

**ADR-0008/0010/0011 remain necessary, and are not made redundant.** Evidence from the same probe: the
first tool call the model emitted contained an unquoted `Transaction` *and* a guessed lowercase
`'groceries'` literal — with tools active. ADR-0011 is the sharpest case: SQLite destroys the second
branch's alias before any observer sees it, so a loop inspecting the rows sees the same collapsed label
a human would. **A loop cannot recover information that was already destroyed.** ADR-0010 likewise
polices a claim the model makes about its own output, which self-inspection cannot independently check.
ADR-0008 is the one partially subsumed — a loop can `SELECT DISTINCT category` and look — but it stays
as the cheaper path and as defense-in-depth.

**ADR-0007 will need superseding at the tool-calling phase, not before.** A loop has one message thread,
so "the narration prompt" stops being a distinct injection site. The `X1` boundary snippet in particular
wants to move earlier, which would close the "refusal happens after the query runs" open question for
free. Deliberately not decided here — it depends on what the loop's message structure turns out to be.

**Chat gets slower and its failure modes change shape.** Fewer confident-wrong answers, more visible
"I couldn't get there" (ADR-0014) and more latency. That is the intended trade.

**Loop control is the weakest link, not SQL syntax.** See ADR-0013's feasibility section — the probe
showed the local model self-correcting along the wrong axis. This ADR commits to the direction and the
envelope; it does not assume the local model is good at driving it.
