# Research wiki: YNAB vs YDB differences

Karpathy-style LLM-maintained knowledge base (pattern shared with exlibris/personal-brand's
`docs/research/`). Logs meaningful differences between how YNAB models/handles data and how YDB
currently does, discovered while building the migration (ADR-0001–0003). The goal is to fold useful
YNAB ideas into YDB's own design later, after the migration tool itself is retired — not to make YDB
imitate YNAB wholesale.

## Schema

One entry per difference, in `findings.md`, using this shape:

```markdown
## <Short title>

**YNAB does:** <what YNAB does>
**YDB does:** <what YDB currently does, or "nothing — not modeled">
**Worth folding in?** Yes / No / Maybe — <one-line reasoning>
**Source:** <how this was discovered — API response, UI observation, etc.>
```

## Rules

- Log differences as they're found during Phase 1 build-out, not retroactively in a batch.
- "Worth folding in?" is a note for future prioritization, not a commitment — `@product-manager`
  triages these into real tickets only when there's appetite to act on them.
- Don't log surface-level naming differences (e.g. "payee" vs "vendor") unless the underlying concept
  differs, not just the word.
