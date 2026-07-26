# Architecture Decision Records

Owned by `@tech-lead`. Filename convention: `NNNN-<slug>.md`, zero-padded to 4 digits (`0001-use-swiftdata.md`).

## Format

```markdown
# ADR-NNNN: <Title>

Status: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
Date: YYYY-MM-DD

## Context
<What situation prompted this decision>

## Decision
<What we decided>

## Consequences
<What this buys us, what it costs, what we give up>
```

## Rules

- One decision per ADR. If it's actually two decisions, split it.
- Keep to one page. If it runs longer, compress it or split it.
- Accepted ADRs are not edited after the fact. Supersede with a new ADR if the decision changes.

## Accepted ADRs

- [0001 — YNAB integration scope](0001-ynab-integration-scope.md) — one-way YNAB→YDB pull, amends `IMPROVEMENT_PLAN.md` §4's "no bank API integrations" non-goal
- [0002 — Manual import before automatic sync](0002-manual-import-before-auto-sync.md) — phased rollout, automatic sync dormant until a named trigger fires
