// YNAB API client — the one piece of outbound external network surface in an
// otherwise LAN-only app (ADR-0001). Deliberately self-contained so the whole
// integration can be removed by deleting this file, app/api/ynab/, the
// YnabImportManager component, the Transaction.ynabId column and two Setting
// rows.
//
// Invariants this file upholds:
//   - Outbound only. YDB pulls; nothing is ever written back to YNAB, and
//     there is no inbound endpoint (ADR-0001).
//   - The personal access token never appears in a thrown error, a log line,
//     or a response body. It travels only in the Authorization header. Every
//     error surfaced from here is safe to show in the UI.
//   - Money crosses the boundary through milliunitsToCents() and nothing else,
//     so YNAB's representation never leaks into YDB's integer-cents ledger.

const YNAB_API_BASE = 'https://api.ynab.com/v1'

// YNAB is a remote HTTP dependency on a manual, user-initiated action — a
// generous-but-bounded timeout, so a hung connection surfaces as an error
// rather than a spinner that never resolves.
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Raised for any failure reaching or reading YNAB. The message is always
 * safe to surface to the user: it never contains the access token.
 */
export class YnabError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YnabError'
  }
}

export type YnabAccount = {
  id: string
  name: string
  type: string
  closed: boolean
  deleted: boolean
  on_budget: boolean
}

export type YnabTransaction = {
  id: string
  date: string
  /** Milliunits (1/1000 of a major unit). Convert with milliunitsToCents(). */
  amount: number
  memo: string | null
  account_id: string
  account_name: string
  payee_name: string | null
  category_name: string | null
  transfer_account_id: string | null
  /** The reciprocal leg's own `id` when this row is one side of a transfer
   *  (credit card/loan payments included — YNAB models those as transfers
   *  too). Null on every non-transfer row. Pairing on this rather than
   *  matching by date/amount is exact and avoids false pairs on same-day,
   *  same-amount coincidences. */
  transfer_transaction_id: string | null
  deleted: boolean
}

type YnabCredentials = { token: string; budgetId: string }

/**
 * Read the YNAB credentials from the environment.
 *
 * Env-only by decision (docs/architecture.md, 2026-07-26): no `Setting`
 * fallback, so the token never lands in the database — where the chat path
 * would be one forgotten allowlist entry away from reading it. The thrown
 * message names the missing variable but never its value.
 */
export function getYnabCredentials(): YnabCredentials {
  const token = process.env.YNAB_ACCESS_TOKEN?.trim()
  const budgetId = process.env.YNAB_BUDGET_ID?.trim()

  const missing: string[] = []
  if (!token) missing.push('YNAB_ACCESS_TOKEN')
  if (!budgetId) missing.push('YNAB_BUDGET_ID')
  if (missing.length > 0) {
    throw new YnabError(
      `YNAB is not configured — ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing from .env`,
    )
  }

  return { token: token as string, budgetId: budgetId as string }
}

/**
 * Convert a YNAB milliunit amount to YDB integer cents.
 *
 * YNAB stores money in milliunits (1/1000 of a major unit), so 2_605_800
 * milliunits is 2605.80 in the budget's currency, i.e. 260_580 cents. Divide
 * by 10 and round — real YNAB amounts are always multiples of 10 milliunits,
 * but rounding keeps a hypothetical sub-cent amount from producing a
 * fractional "cent" and poisoning the integer-cents invariant.
 *
 * Lives here rather than in lib/money.ts because milliunits are a YNAB
 * concept; lib/money.ts owns the cents↔major-unit boundary only.
 */
export function milliunitsToCents(milliunits: number): number {
  if (!Number.isFinite(milliunits)) return 0
  return Math.round(milliunits / 10)
}

/** Shared fetch wrapper: auth header, timeout, and token-free error messages. */
async function ynabFetch<T>(path: string, creds: YnabCredentials): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${YNAB_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    // Swallow the underlying error rather than re-wrapping it: fetch failure
    // messages can echo request detail, and this path must stay token-free.
    throw new YnabError('Could not reach YNAB — check the network connection')
  }

  if (!res.ok) {
    // 401 is by far the most likely failure (expired/revoked token), so name it
    // specifically. Never include the response body verbatim.
    if (res.status === 401) {
      throw new YnabError('YNAB rejected the access token (401) — it may have been revoked')
    }
    if (res.status === 404) {
      throw new YnabError('YNAB budget not found (404) — check YNAB_BUDGET_ID')
    }
    if (res.status === 429) {
      throw new YnabError('YNAB rate limit reached (429) — wait a few minutes and retry')
    }
    throw new YnabError(`YNAB returned ${res.status}`)
  }

  const body = (await res.json().catch(() => null)) as { data?: T } | null
  if (!body || body.data == null) {
    throw new YnabError('YNAB returned an unexpected response shape')
  }
  return body.data
}

/**
 * All non-deleted accounts on the budget, in YNAB's own order.
 *
 * Closed accounts are returned rather than filtered — the mapping UI shows
 * them so historical transactions on a since-closed account can still be
 * mapped, but only open accounts are *required* to have a mapping.
 */
export async function fetchYnabAccounts(): Promise<YnabAccount[]> {
  const creds = getYnabCredentials()
  const data = await ynabFetch<{ accounts: YnabAccount[] }>(
    `/budgets/${encodeURIComponent(creds.budgetId)}/accounts`,
    creds,
  )
  const accounts = Array.isArray(data.accounts) ? data.accounts : []
  return accounts.filter((a) => !a.deleted)
}

/**
 * Importable transactions, plus the delta cursor to persist for the next pull.
 *
 * When `serverKnowledge` is supplied, YNAB returns only what changed since
 * that cursor — the first tier of the idempotency story (the `ynabId` unique
 * constraint and the pre-insert filter are the other two). Omitted on the
 * first run, which pulls full history; that matches the "reset the ledger,
 * then import" sequencing in ADR-0003.
 *
 * NOTE the query parameter is `last_knowledge_of_server`, not
 * `server_knowledge`. YNAB *silently ignores* an unrecognised parameter and
 * returns full history with a 200, so getting this name wrong degrades every
 * delta pull into a full re-scan without any error to notice.
 *
 * Only tombstones (`deleted: true`, present in delta responses) are dropped
 * here. Transfer legs (`transfer_account_id != null`) are returned — they're
 * paired into YDB's two-sided transfer model by `planYnabImport` in
 * lib/ynabImport.ts, not filtered here, because credit card/loan payments are
 * modelled as transfers too and dropping them was the balance-correctness bug
 * this file used to have (see docs/research/ynab-vs-ydb/findings.md).
 *
 * `payee_name === "Starting Balance"` rows are deliberately NOT dropped here
 * either. YNAB models each account's opening balance as an ordinary
 * transaction rather than account metadata; YDB models the same amount as
 * `Account.openingBalance`. The double-count these two would otherwise cause
 * is resolved operationally, not in this filter: ADR-0003's reset recreates
 * every account with `openingBalance: 0`, so these rows importing as normal
 * transactions *are* how the opening balance reaches YDB. Filtering them out
 * here would silently drop that money instead of double-counting it — worse,
 * because it fails quietly on every account, not loudly on none.
 */
export async function fetchYnabTransactions(serverKnowledge?: string | null): Promise<{
  transactions: YnabTransaction[]
  serverKnowledge: string
  skippedDeleted: number
}> {
  const creds = getYnabCredentials()
  const cursor = serverKnowledge?.trim()
  const query = cursor ? `?last_knowledge_of_server=${encodeURIComponent(cursor)}` : ''

  const data = await ynabFetch<{ transactions: YnabTransaction[]; server_knowledge: number }>(
    `/budgets/${encodeURIComponent(creds.budgetId)}/transactions${query}`,
    creds,
  )

  const all = Array.isArray(data.transactions) ? data.transactions : []
  const notDeleted = all.filter((t) => !t.deleted)

  return {
    transactions: notDeleted,
    serverKnowledge: String(data.server_knowledge ?? ''),
    skippedDeleted: all.length - notDeleted.length,
  }
}
