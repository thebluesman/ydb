# Findings

## Two-wallet / two-checking-account modeling

**YNAB does:** Tracks "Wallet - Shyam" and "Wallet - Super" as separate cash accounts, and
"Salary Account" and "ENBD" as separate checking accounts — finer-grained than a single shared
account per type.
**YDB does:** One `Wallet` (cash) and one `ENBD` (current) account existed pre-reset; no concept of
per-person sub-accounts of the same type.
**Worth folding in?** Maybe — depends on whether Shyam wants per-person cash tracking inside a
household budget, or whether this was just how the accounts happened to get named in YNAB. Revisit
once the full account list is confirmed during account recreation.
**Source:** `GET /budgets/{id}/accounts`, compared against `Account` table, 2026-07-26.
