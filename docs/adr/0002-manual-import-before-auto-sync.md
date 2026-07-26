# ADR-0002: Manual import before automatic sync

Status: Accepted
Date: 2026-07-26

## Context

ADR-0001 scopes a one-way YNAB→YDB integration for migration purposes. The end goal is a fully
automatic pipeline (SMS → Signal → YNAB → YDB), but building the standing background-sync version
first means debugging parsing/mapping edge cases in a job that runs unattended against real money
data. Shyam asked for the manual version first, with automatic sync explicitly deferred rather than
dropped.

## Decision

Ship in two phases:

1. **Phase 1 (active now): manual "Import from YNAB" button.** Lives in Settings, alongside the
   existing CSV import (`IMPROVEMENT_PLAN.md` Phase 7 / M6 — same section, same interaction pattern).
   User-triggered pull of transactions since the last successful import. Must be idempotent: YNAB
   transaction IDs are stored against imported YDB rows so re-running never duplicates. Requires an
   account/category mapping between YNAB and YDB, configured once.
2. **Phase 2 (dormant): automatic background sync.** Not built until Phase 1 has run in daily use
   long enough to trust the parsing/mapping logic. Trigger to activate Phase 2: Shyam has used the
   manual button for at least a few weeks with no mis-mapped transactions requiring correction.

`@backend-engineer` owns the implementation of both phases; Phase 2 stays dormant (per its agent
definition) until the trigger above is explicitly declared met.

## Consequences

- Buys a smaller, reviewable first change and a real-world trust-building period before anything runs
  unattended against financial data.
- Costs a manual step during the transition period (acceptable — Shyam already does far more manual
  work today going through SMS one by one).
- Given up: the "fully hands-off" experience is delayed, not abandoned.
