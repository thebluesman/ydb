import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { validateTransactionWrite } from '@/lib/transactionValidation'
import { fromCents } from '@/lib/money'
import {
  TRANSACTION_INCLUDE,
  buildCountSql,
  buildExportIdsSql,
  buildPageIdsSql,
  buildPendingSql,
  buildStatsSql,
  parseLedgerQuery,
  resolveCurrencyScope,
  toNumber,
  type CurrencyScope,
  type LedgerQuery,
} from '@/lib/transactions-query'

// Server-driven ledger query (Phase 1). Filtering, sorting, pagination, and
// stats all run in SQLite — response time and payload are independent of the
// total table size (only the requested page is serialised, with its 5
// includes). The shared predicate/aggregation lives in lib/transactions-query.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const q = parseLedgerQuery(url.searchParams)

  const [accounts, baseCurrencySetting] = await Promise.all([
    prisma.account.findMany({ where: { isActive: true }, select: { id: true, currency: true } }),
    prisma.setting.findFirst({ where: { key: 'baseCurrency' } }),
  ])
  const baseCurrency = baseCurrencySetting?.value ?? accounts[0]?.currency ?? 'GBP'
  const scope = resolveCurrencyScope(accounts, q.accountId, baseCurrency)

  // CSV export: stream the full filtered set (no pagination). Escapes
  // formula-injection sigils.
  if (q.format === 'csv') {
    return exportCsv(q, scope)
  }

  const pageIds = buildPageIdsSql(q, scope)
  const countSql = buildCountSql(q, scope)
  const stats = buildStatsSql(q, scope)
  const pending = buildPendingSql(scope, q.accountId)

  // Page rows, count, stats and pending all derive from the one raw predicate
  // (buildFilterSql) so the visible rows and the stat counts can't diverge on a
  // `%`/`_` search term. Rows are selected by id, then hydrated with relations.
  const [idRows, countRows, statsRows, pendingRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ id: number }>>(pageIds.sql, ...pageIds.params),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(countSql.sql, ...countSql.params),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(stats.sql, ...stats.params),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(pending.sql, ...pending.params),
  ])

  const rows = await hydrateRows(idRows.map((r) => toNumber(r.id)))
  const total = toNumber(countRows[0]?.count)

  const s = statsRows[0] ?? {}
  const p = pendingRows[0] ?? {}
  const income = toNumber(s.income)
  const expenses = toNumber(s.expenses)

  return NextResponse.json({
    rows,
    total,
    stats: {
      income,
      expenses,
      net: income - expenses,
      incomeCount: toNumber(s.incomeCount),
      expenseCount: toNumber(s.expenseCount),
      currency: scope.currency,
      pendingReimbursementCount: toNumber(p.count),
      pendingReimbursementOutstanding: toNumber(p.outstanding),
    },
  })
}

// Hydrate a list of transaction ids (in order) into full rows with the ledger
// relations. Ids come from the raw-SQL id query; a single Prisma findMany then
// attaches the includes, re-sorted back into the id order.
async function hydrateRows(ids: number[]) {
  if (ids.length === 0) return []
  const rows = await prisma.transaction.findMany({
    where: { id: { in: ids } },
    include: TRANSACTION_INCLUDE,
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r != null)
}

// Excel/Sheets treat cells beginning with =, +, -, @, \t, \r as formulas.
// Prefixing with a single quote neutralises that without breaking the value.
function csvCell(raw: string | number | null | undefined): string {
  const s = raw == null ? '' : String(raw)
  const needsEscape = /^[=+\-@\t\r]/.test(s)
  const safe = needsEscape ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

async function exportCsv(q: LedgerQuery, scope: CurrencyScope) {
  const { sql, params } = buildExportIdsSql(q, scope)
  const idRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(sql, ...params)
  const ids = idRows.map((r) => toNumber(r.id))

  type CsvRow = {
    id: number
    date: Date
    description: string
    originalDescription: string | null
    transactionType: string
    amount: number
    category: string
    status: string
    notes: string | null
    account: { name: string }
  }
  let rows: CsvRow[] = []
  if (ids.length > 0) {
    const fetched = await prisma.transaction.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        date: true,
        description: true,
        originalDescription: true,
        transactionType: true,
        amount: true,
        category: true,
        status: true,
        notes: true,
        account: { select: { name: true } },
      },
    })
    const byId = new Map(fetched.map((r) => [r.id, r]))
    rows = ids.map((id) => byId.get(id)).filter((r): r is CsvRow => r != null)
  }
  const headers = ['Date', 'Description', 'Original Description', 'Type', 'Amount', 'Category', 'Account', 'Status', 'Notes']
  const body = rows.map((t) =>
    [
      new Date(t.date).toISOString().split('T')[0],
      t.description ?? '',
      t.originalDescription ?? '',
      t.transactionType,
      fromCents(t.amount).toFixed(2),
      t.category,
      t.account.name,
      t.status,
      t.notes ?? '',
    ]
      .map(csvCell)
      .join(','),
  )
  const csv = [headers.map(csvCell).join(','), ...body].join('\n')
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="transactions-${new Date().toISOString().split('T')[0]}.csv"`,
    },
  })
}

type IncomingTx = {
  date: string
  amount: number
  description: string
  originalDescription?: string
  transactionType: string
  category: string
  accountId: number
  notes?: string
  rawSource?: string
  status?: string
  transferCounterpartAccountId?: number | null
}

export async function POST(request: Request) {
  const body: Array<IncomingTx> = await request.json()

  if (!Array.isArray(body) || body.length === 0) {
    return NextResponse.json({ error: 'Expected non-empty array of transactions' }, { status: 400 })
  }

  // Validate each row up front. Imports are one-sided by nature so transfers
  // without a counterpart are allowed. Any other violation (wrong sign for
  // the declared type, self-transfer, cross-currency transfer) rejects the
  // whole batch so the user can fix the source and retry atomically.
  for (let i = 0; i < body.length; i++) {
    const row = body[i]
    const invalid = await validateTransactionWrite(
      {
        transactionType: row.transactionType,
        amount: row.amount,
        accountId: row.accountId,
        transferCounterpartAccountId: row.transferCounterpartAccountId ?? null,
      },
      { allowOneSidedTransfer: true },
    )
    if (invalid) {
      return NextResponse.json({ ...invalid, row: i }, { status: 400 })
    }
  }

  // Statements only produce one side of a transfer per file, so transfers
  // in an import batch are normally one-row entries. When the caller sets
  // transferCounterpartAccountId we still trust a one-row insert for
  // backward compatibility (the statement being imported IS one side).
  // createMany handles the non-paired rows in a single round trip.
  const rows = body.map((t) => ({
    date: new Date(t.date),
    amount: t.amount,
    description: t.description,
    originalDescription: t.originalDescription ?? null,
    transactionType: t.transactionType ?? (t.amount >= 0 ? 'credit' : 'debit'),
    category: t.category ?? '',
    accountId: t.accountId,
    notes: t.notes ?? null,
    rawSource: t.rawSource ?? null,
    status: t.status ?? 'committed',
    transferCounterpartAccountId: t.transferCounterpartAccountId ?? null,
  }))

  const result = await prisma.transaction.createMany({ data: rows })
  return NextResponse.json({ count: result.count })
}
