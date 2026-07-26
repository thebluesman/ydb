# ADR-0003: Full reset of YDB ledger data before YNAB import

Status: Accepted
Date: 2026-07-26

## Context

ADR-0001/0002 originally assumed mapping YNAB accounts onto YDB's existing accounts. Comparing the
two (`docs/architecture.md`) showed the mapping isn't clean — YNAB has accounts (a second checking
account, a second cash wallet) with no YDB counterpart, and the reverse would require guessing intent
rather than reading it off real data. Shyam confirmed YDB's current ledger data isn't precious — YNAB
is the trusted source of truth for the migration period.

## Decision

Before Phase 1 import work begins moving real data, **fully reset YDB's ledger data**: Accounts,
Transactions, ImportRecords, Categories, VendorRules, and Budgets. Recreate accounts fresh to mirror
YNAB's account list 1:1 (same names, type mapping: `checking`→`current`, `savings`→`savings`,
`creditCard`→`credit`, `personalLoan`→`personal_loan`, `autoLoan`→`auto_loan`, `cash`→`cash`).
Categories/VendorRules/Budgets get rebuilt against however YNAB actually categorizes things, rather
than carrying over YDB's old scheme.

**Sequencing:** the reset happens as the last step before the first real import runs, once the import
pipeline is built and tested — not immediately. This avoids a window where YDB is empty with no
working way to repopulate it.

**Documentation requirement:** wherever YNAB's data model or workflow differs meaningfully from YDB's
current assumptions (category structure, goals, split transactions, etc.), log it in
`docs/research/ynab-vs-ydb/` as it's discovered, so those differences can be folded into YDB's design
later rather than lost once the migration tool is retired.

## Consequences

- Buys a clean, unambiguous account list with no manual reconciliation guesswork.
- Costs: all of YDB's existing transaction history is discarded. Accepted — Shyam confirmed YNAB is
  the trusted record, not YDB, for this period.
- Given up: any YDB-specific categorization refinements built up before this reset (they can be
  rebuilt, informed by the research wiki above).
