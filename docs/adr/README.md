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
- [0003 — Full reset before YNAB import](0003-full-reset-before-ynab-import.md) — wipe YDB ledger data and recreate accounts 1:1 from YNAB with `openingBalance: 0`
- [0004 — YNAB edits and deletions are detected and reported, never applied](0004-ynab-mutations-detect-and-report.md) — Phase 1 surfaces divergence for manual resolution; no update/delete propagation (detection mechanism superseded by 0005)
- [0005 — YNAB change detection compares against an immutable snapshot](0005-ynab-change-detection-immutable-snapshot.md) — frozen `ynabFingerprint` column of YNAB-native values, so local edits can never register as YNAB-side changes
- [0006 — All LLM inference stays local](0006-local-only-llm-inference.md) — self-hosted Ollama only, no hosted inference API; rules out a hosted fallback for complex chat queries
- [0007 — Chat knowledge is injected into the narration prompt only](0007-chat-knowledge-injected-into-narration-only.md) — `docs/knowledge/` P0 snippets go in the narration system prompt, never the SQL prompt; read-only guard verified unaffected
- [0008 — Chat SQL is grounded in the stored category vocabulary](0008-chat-sql-category-vocabulary-grounding.md) — real `Transaction.category` values injected into the SQL prompt at request time; an unmatched category fails loudly instead of returning an empty aggregate
- 0009 — Balance composition is out of scope for chat-generated SQL — **superseded by 0010** (misdiagnosed repro; the `openingBalance` check would not have caught the actual bug)
- 0010 — Balance semantics are out of scope for chat SQL, enforced on the result label — **superseded by 0015** (its premise that narration sees only the result columns is false; narration also sees the question, and a `SUM(amount)` aliased `net` was narrated as a balance)
- [0011 — Chat SQL returns each metric as its own column](0011-chat-sql-no-union-compound-selects.md) — `UNION` rejected in generated SQL; SQLite's compound-select naming was collapsing two aggregate labels into one before narration saw them
- [0012 — The chat pipeline's target architecture is a bounded agentic loop](0012-agentic-chat-loop-target-architecture.md) — ReAct-style loop over Ollama tool-calling, `run_sql` as the only execution tool; point fixes stay but stop being the strategy
- [0013 — Phase A is a verification pass, not a tool-calling loop](0013-verification-pass-before-tool-calling-loop.md) — sequences ADR-0012 into three gated phases; Phase A also produces the eval data the chat path has never had
- [0014 — A non-answer is a first-class chat response](0014-non-answer-is-a-first-class-chat-response.md) — `no-answer` stream type with four reasons, distinct from narration and from HTTP errors; "no matching rows" stops rendering as a confident zero
- [0015 — Balance scope is enforced on the question, before SQL is generated](0015-balance-scope-enforced-on-the-question.md) — supersedes 0010; a stock-noun check on the question refuses pre-generation, with 0010's alias and `openingBalance` checks kept as a second net
- [0016 — Guard enforcement splits on what the generated SQL alone can decide](0016-guard-enforcement-split-on-sql-decidability.md) — code-level detectors only where a guard's applicability is a property of the SQL; split-leg and reimbursement stay prompt-only, held consistent by a guard-matrix test over the worked examples
- [0017 — Balance scope is also enforced on result-row keys](0017-balance-scope-enforced-on-result-row-keys.md) — the star-expansion net; `SELECT *` over `Account` returns `openingBalance` without ever naming it, so the same two rules run on what came back. The one post-execution guard in the pipeline
- [0018 — Chat SQL is grounded in the stored account-name vocabulary](0018-chat-sql-account-name-vocabulary-grounding.md) — ADR-0008's mechanism on `Account.name`, the column it explicitly scoped out; the qualifier is resolved off `FROM`/`JOIN` rather than assumed, and fails open
- [0019 — The transfer-exclusion guard triggers on the aggregate, not the sign branch](0019-transfer-exclusion-triggers-on-the-aggregate-not-the-sign-branch.md) — closes ADR-0016's residual with ledger data: transfer legs do carry real spend categories (loan repayments), so category-filtered spend aggregates need the guard too; stays prompt-only because the mirror case is question-dependent
- [0020 — Money units are normalized server-side, not inferred by the narrator](0020-money-units-normalized-server-side.md) — raw-cents row projections (`Transaction.amount`, `Account.creditLimit`) reached narration under an "infer from context" clause; a projection classifier resolves money columns against the schema and converts before narration, refusing projections it cannot resolve
- [0021 — Transfer-pair integrity is enforced by a DB trigger, on exclusivity rather than symmetry](0021-transfer-pair-exclusivity-enforced-by-db-trigger.md) — closes FOLLOWUPS §5's last item; two `AFTER` triggers on `"Transaction"` abort self-links, stealing a taken counterpart, and orphaning an inbound pointer, while leaving `ON DELETE SET NULL` survivors and transient one-sided states legal
- [0022 — The transfer-pair trigger also rejects a second claim on the same target](0022-transfer-pair-trigger-rejects-a-second-claim-on-the-same-target.md) — narrows ADR-0021's enforced predicate with a fourth condition; two rows could both claim a still-NULL counterpart and pass all three original checks, a dead end no later legal write repairs
