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

## Opening balances are real transactions, not an account field

**YNAB does:** Models each account's starting balance as an ordinary transaction with
`payee_name: "Starting Balance"` — one per account, dated when the account was created. All 10
accounts on the budget have one, and they carry the largest amounts in the whole dataset (the
Personal Loan starting balance is −188,847,790 milliunits, i.e. −1,888,477.90). They are
indistinguishable from real transactions in the API: no flag, no special category — two of them land
in `Uncategorized` and the rest in `Inflow: Ready to Assign`.
**YDB does:** Models the same thing as two columns on the account — `Account.openingBalance` and
`openingBalanceDate` — which `computeBalance` folds in separately from the transaction sum.
**Worth folding in?** No — but this was an active double-counting hazard for the import, not just a
modeling difference. Importing these rows as transactions on an account that also has a non-zero
`openingBalance` would count the same money twice. **Resolved 2026-07-26 (Shyam):** the importer keeps
importing these rows as ordinary transactions — no filter added — and instead the operational
requirement is on the ADR-0003 reset: every account recreated there must be created with
`openingBalance: 0`, so the "Starting Balance" transaction is the *sole* source of that account's
opening balance in YDB, arriving through the normal transaction sum rather than a duplicated field.
Filtering these rows out (the alternative considered) would have silently dropped that money instead
of double-counting it, which is worse — it fails quietly on every account instead of loudly on none.
**Source:** `GET /budgets/{id}/transactions` full pull (224 rows), while building the Phase 1
importer, 2026-07-26.

## Delta cursor parameter is `last_knowledge_of_server`, and a wrong name fails silently

**YNAB does:** Accepts the delta cursor as `?last_knowledge_of_server=<n>` on the transactions
endpoint, while *returning* it as `data.server_knowledge`. The names differ between request and
response. Passing `?server_knowledge=<n>` — the response's own field name — returns HTTP 200 with the
**full history** and no error or warning of any kind.
**YDB does:** Persists the cursor in `Setting.ynabServerKnowledge` and sends it as
`last_knowledge_of_server` (`fetchYnabTransactions` in `lib/ynab.ts`).
**Worth folding in?** N/A — this is an integration correctness note. Recording it because the failure
mode is invisible: the wrong parameter name degrades every incremental pull into a full re-scan that
still "works" (the `ynabId` unique constraint absorbs the duplicates), so nothing would ever surface
the bug except a slow import. Verified both spellings against the live budget: 0 rows returned with
`last_knowledge_of_server=1168`, 224 rows with `server_knowledge=1168`.
**Source:** `GET /budgets/{id}/transactions` with both parameter spellings, 2026-07-26.

## Split transactions expose their legs, but only as nested subtransactions

**YNAB does:** Returns a split as a single top-level transaction with `category_name: "Split"`, the
full amount, and a populated `subtransactions[]` array holding the real per-category breakdown. The
legs are never top-level rows, so a plain read of the transactions endpoint sees the total and the
literal string `"Split"` where a category should be. One such row exists on the budget today: Amazon,
−147,060 milliunits, split three ways across `📚 Books` / `🛒 Groceries` / `🎁 Holidays & gifts`.
**YDB does:** Has a first-class split model — `Transaction.parentTransactionId` / `splitLegs` with a
cascade delete — so it could represent this faithfully.
**Worth folding in?** Yes, eventually — YDB already has the schema for it, so mapping
`subtransactions[]` onto `splitLegs` is a natural Phase 2 (or late Phase 1) addition. Until then
splits import as one row categorised `"Split"`, which is honest but loses the breakdown. Low urgency
at one affected row.
**Source:** `GET /budgets/{id}/transactions`, `subtransactions[]` inspection, 2026-07-26.

## Category names are emoji-prefixed and include YNAB's own control buckets

**YNAB does:** Uses display names as the only stable handle for a category in the transactions
response, and those names carry emoji prefixes (`🛒 Groceries`, `⚡️ DEWA`, `💇🏾 Grooming` — including
a skin-tone modifier). It also mixes in two names that aren't user categories at all:
`Inflow: Ready to Assign` (its income bucket, 11 rows) and `Split` (see above). `category_name` is
nullable per the API, though every row on this budget currently has one.
**YDB does:** `Category.name` is a plain unique string with a colour; `colorForCategory` hashes the
name to pick one, so emoji make no difference to it.
**Worth folding in?** Maybe — the emoji are genuinely useful as visual anchors in the ledger, and
taking them verbatim (per ADR-0003) means YDB inherits them for free. Worth revisiting is whether
`Inflow: Ready to Assign` should stay under that name or be renamed to something YDB-native like
`Income`, since it will show up as a category on the dashboard.
**Source:** Distinct `category_name` values across a full 224-row pull, 2026-07-26.

## Credit card and loan payments are modeled as transfers, not spend

**YNAB does:** Represents every money movement between two of the user's own accounts —
inter-account transfers, and specifically credit card/loan payments — as a linked pair of
transactions, one row per account, cross-referenced by `transfer_transaction_id` (each row names the
other's own `id` directly, so pairing is exact, not a date/amount heuristic). `payee_name` on these
rows is synthesized as `"Transfer : <other account name>"`. There is no separate "payment" concept —
paying off `U by Emaar` from `Salary Account` is the same mechanism as moving money into `Liv`
savings.
**YDB does:** Has a first-class two-sided transfer model already (`transactionType: 'transfer'`,
`transferCounterpartAccountId`, `linkedTransferId` — the same shape manual transfers use in
`app/api/transactions/manual/route.ts`), but the importer's first version dropped every
`transfer_account_id != null` row outright, scoped out as "added complexity" for Phase 1.
**Worth folding in?** Already folded in — this was a real bug, not a style choice. Dropping transfers
silently broke every account balance that regularly moves money to another mapped account (which is
most of them): on the Salary Account specifically, the discarded transfers netted to −35,918.14,
turning a real balance of 536.09 into a displayed 36,454.23. **Resolved 2026-07-26 (Shyam):**
`fetchYnabTransactions` now returns transfer legs; `planYnabImport` in `lib/ynabImport.ts` pairs them
by `transfer_transaction_id` and writes them through YDB's existing transfer model when both sides'
accounts are mapped and share a currency. Verified against the live budget after the fix: 8 of 10
recreated accounts (all except the two loan accounts — see next entry) now compute to YNAB's exact
real balance from the transaction history alone.
**Source:** `GET /budgets/{id}/accounts/{id}/transactions` per-account balance vs. computed ledger
sum, discovered via the dashboard after the first real import (198 rows, transfers excluded),
2026-07-26.

## Loan accounts accrue interest that never becomes a transaction

**YNAB does:** For `personalLoan`/`autoLoan` (debt-tracking) accounts, the account record carries
`debt_interest_rates`, `debt_minimum_payments`, and `debt_escrow_amounts` — an amortization schedule
YNAB uses to compute a displayed `balance` that includes accrued-but-unposted interest. That accrued
interest has no representation anywhere in `/transactions`; the transaction list only shows the
actual starting balance and payments made. Confirmed against the live budget: Car Loan's raw
transaction sum is −121,923.09 but its API `balance` field reads −122,425.36 (a 502.27 gap); Personal
Loan is off by 2,177.20 the same way. `Car Loan` is also `on_budget: false` (a tracking account, not a
budget account).
**YDB does:** `computeBalance` (`lib/accounts.ts`) is purely `openingBalance ± Σtransaction.amount` —
no accrual concept, no amortization schedule.
**Worth folding in?** Not right now, and not by copying YNAB's approach even later — Shyam noted
YNAB's own amortization isn't accurate anyway, so the bar for a future fix is computing real interest
accrual correctly, not replicating `debt_interest_rates`. Until then this is a known, growing gap:
`Personal Loan`/`Car Loan` balances in YDB will run slightly behind YNAB's displayed figure and drift
further as more interest accrues without a posted transaction. Every other account type is unaffected.
**Source:** `GET /budgets/{id}/accounts/{id}` (`debt_interest_rates` field) vs. transaction-sum
projection, cross-checked against a full 224-row pull, 2026-07-26.

## Amounts arrive in milliunits, with pre-formatted companions

**YNAB does:** Returns `amount` in milliunits (1/1000 of a major unit), alongside undocumented
convenience fields `amount_formatted` (`"AED2605.80"`) and `amount_currency` (`2605.8`, a float).
Every amount on the budget is a clean multiple of 10 milliunits. Outflows are negative and inflows
positive — already YDB's sign convention. One genuinely zero-amount transaction exists (the
`Wallet - Shyam` starting balance).
**YDB does:** Integer cents everywhere. `milliunitsToCents` (`lib/ynab.ts`) divides by 10 and rounds;
the float `amount_currency` field is deliberately ignored so no float ever touches the ledger.
**Worth folding in?** No — milliunits buy YNAB sub-cent precision YDB has no use for, and the
formatted/float variants are exactly the shortcut the integer-cents invariant exists to prevent.
Logged so nobody later "simplifies" the conversion by reading `amount_currency`.
**Source:** Full transactions pull, cross-checked `2605800` milliunits → `260580` cents against
`amount_formatted: "AED2605.80"`, 2026-07-26.
