import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchYnabTransactions, type YnabTransaction } from '@/lib/ynab'

// fetchYnabTransactions against a stubbed YNAB API: the delta endpoint
// (`last_knowledge_of_server`) and the non-delta list (`since_date`) are
// answered separately, mirroring how YNAB actually behaves for a match.

function tx(overrides: Partial<YnabTransaction>): YnabTransaction {
  return {
    id: 'tx',
    date: '2026-09-25',
    amount: -5028000,
    memo: null,
    account_id: 'salary',
    account_name: 'Salary Account',
    payee_name: null,
    category_name: null,
    category_id: null,
    transfer_account_id: null,
    transfer_transaction_id: null,
    matched_transaction_id: null,
    deleted: false,
    ...overrides,
  }
}

// The real 2026-10-12 pair: a scheduled transfer the user entered, matched to
// the SMS-captured import, which YNAB then hid.
const visibleHalf = tx({
  id: 'sched_2026-09-25',
  payee_name: 'Transfer : Personal Loan',
  transfer_account_id: 'loan',
  transfer_transaction_id: 'sched_t_2026-09-25',
  matched_transaction_id: 'hidden-import',
})
const hiddenHalf = tx({
  id: 'hidden-import',
  memo: 'Captured from Salary Account personal loan EMI SMS (transfer)',
  matched_transaction_id: 'sched_2026-09-25',
})
const ordinary = tx({ id: 'groceries', date: '2026-09-30', amount: -6500, payee_name: 'Al Madina' })

type Route = { delta: YnabTransaction[]; list?: YnabTransaction[] }

function stubYnab(route: Route) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    const transactions = url.includes('since_date=') ? (route.list ?? []) : route.delta
    return new Response(JSON.stringify({ data: { transactions, server_knowledge: 42 } }), { status: 200 })
  })
  return calls
}

beforeEach(() => {
  vi.stubEnv('YNAB_ACCESS_TOKEN', 'test-token')
  vi.stubEnv('YNAB_BUDGET_ID', 'budget')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('fetchYnabTransactions — hidden matched halves', () => {
  it('drops the matched row YNAB hides and keeps its visible counterpart', async () => {
    stubYnab({ delta: [visibleHalf, hiddenHalf, ordinary], list: [visibleHalf, ordinary] })
    const { transactions } = await fetchYnabTransactions('1168')
    expect(transactions.map((t) => t.id)).toEqual(['sched_2026-09-25', 'groceries'])
  })

  it('scopes the visibility check to the earliest matched row and only runs it once', async () => {
    const calls = stubYnab({ delta: [ordinary, visibleHalf, hiddenHalf], list: [visibleHalf] })
    await fetchYnabTransactions('1168')
    const listCalls = calls.filter((u) => u.includes('since_date='))
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]).toContain('since_date=2026-09-25')
  })

  it('makes no extra request when the pull has no matched rows', async () => {
    const calls = stubYnab({ delta: [ordinary] })
    const { transactions } = await fetchYnabTransactions('1168')
    expect(transactions).toEqual([ordinary])
    expect(calls).toHaveLength(1)
  })

  it('keeps unmatched rows even when the visibility list omits them', async () => {
    // The list is only consulted for matched rows — an ordinary row outside
    // its since_date window must never be filtered by it.
    stubYnab({ delta: [tx({ id: 'older', date: '2026-09-01' }), visibleHalf, hiddenHalf], list: [visibleHalf] })
    const { transactions } = await fetchYnabTransactions('1168')
    expect(transactions.map((t) => t.id)).toEqual(['older', 'sched_2026-09-25'])
  })
})
