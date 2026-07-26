export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { colorForCategory } from '@/lib/category-colors'
import { validateTransactionWrite } from '@/lib/transactionValidation'
import { YnabError } from '@/lib/ynab'
import {
  YNAB_ACCOUNT_MAP_KEY,
  YNAB_SERVER_KNOWLEDGE_KEY,
  filterAlreadyImported,
  filterAlreadyImportedTransfers,
  planYnabImport,
  summarisePlan,
  validateAccountMap,
  type PlannedRow,
  type YnabAccountMap,
} from '@/lib/ynabImport'

// The one write path of the YNAB integration (ADR-0001: one-way, YDB never
// writes to YNAB). Same fetch and mapping as /api/ynab/preview, then commits.
//
// Safe to re-run by construction — see planYnabImport for the three
// independent idempotency layers. A second run against an unchanged budget
// reports `imported: 0`.
export async function POST(request: Request) {
  let body: { accountMap?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 })
  }

  const invalidMap = await validateAccountMap(body.accountMap)
  if (invalidMap) return NextResponse.json(invalidMap, { status: 400 })
  const accountMap = body.accountMap as YnabAccountMap

  let plan
  try {
    plan = await planYnabImport(accountMap)
  } catch (err) {
    if (err instanceof YnabError) {
      return NextResponse.json({ error: err.message }, { status: 502 })
    }
    // See the note in /api/ynab/preview: the token never reaches this path, so
    // logging the underlying fault is safe and is the only way to debug a 500.
    console.error('[ynab] import fetch/plan failed:', err)
    return NextResponse.json({ error: 'Could not fetch transactions from YNAB' }, { status: 500 })
  }

  // Validate every row — regular and each side of every transfer — against
  // the sign-rule/transfer invariants (lib/accounts.ts, transactionValidation)
  // BEFORE writing anything, exactly as POST /api/transactions does. A
  // violation rejects the whole batch rather than importing the good rows and
  // dropping the bad ones — a silent partial import of financial data is the
  // failure mode most likely to go unnoticed.
  const rowsToValidate: PlannedRow[] = [
    ...plan.rows,
    ...plan.transfers.flatMap((t) => [t.side1, t.side2]),
  ]
  for (let i = 0; i < rowsToValidate.length; i++) {
    const row = rowsToValidate[i]
    const invalid = await validateTransactionWrite({
      transactionType: row.transactionType,
      amount: row.amount,
      accountId: row.accountId,
      transferCounterpartAccountId: row.transferCounterpartAccountId ?? null,
    })
    if (invalid) {
      return NextResponse.json(
        {
          ...invalid,
          row: i,
          ynabId: row.ynabId,
          description: row.description,
          message: `YNAB transaction "${row.description}" (${row.date.toISOString().split('T')[0]}) would violate the ledger's sign rules — nothing was imported.`,
        },
        { status: 400 },
      )
    }
  }

  // An empty plan still runs the commit block: the user has approved this
  // mapping, and advancing the cursor past a no-op response keeps the next
  // pull small. createMany with an empty array is a no-op.
  const categoryNames = [...new Set(rowsToValidate.map((r) => r.category))]

  const importedAt = new Date()
  const importLabel = `YNAB import ${importedAt.toISOString().split('T')[0]}`

  try {
    // One transaction around the whole commit so the delta cursor can never
    // advance past rows that failed to insert. If any step throws, the cursor
    // stays where it was and the next run re-pulls the same window.
    const imported = await prisma.$transaction(async (tx) => {
      // Re-check for already-imported rows inside the write transaction. SQLite
      // serialises writers, so nothing can be inserted between this read and
      // the createMany below — this is what replaces the unsupported
      // `createMany({ skipDuplicates: true })` on SQLite.
      const { rows } = await filterAlreadyImported(tx, plan.rows)

      // Categories come from YNAB verbatim (ADR-0003) — YDB's category set is
      // rebuilt around YNAB's scheme, so any name YNAB uses becomes a Category
      // row. Upsert by name matches the categories API; the colour is only
      // assigned on create so a hand-picked colour survives re-imports.
      for (const name of categoryNames) {
        await tx.category.upsert({
          where: { name },
          update: {},
          create: { name, color: colorForCategory(name) },
        })
      }

      const result = await tx.transaction.createMany({
        data: rows.map((r) => ({
          date: r.date,
          amount: r.amount,
          description: r.description,
          originalDescription: r.originalDescription,
          transactionType: r.transactionType,
          category: r.category,
          accountId: r.accountId,
          status: 'committed',
          rawSource: 'ynab',
          createdVia: 'import',
          ynabId: r.ynabId,
        })),
      })

      const countsByAccount = new Map<number, number>()
      for (const r of rows) {
        countsByAccount.set(r.accountId, (countsByAccount.get(r.accountId) ?? 0) + 1)
      }

      // Transfers can't go through createMany: each pair needs the first
      // side's generated id before the second side can be written with
      // linkedTransferId pointing back to it — same shape
      // app/api/transactions/manual/route.ts uses for a manual transfer.
      // Re-check for already-imported pairs inside the transaction, same
      // reasoning as filterAlreadyImported above.
      const { transfers: transfersToWrite } = await filterAlreadyImportedTransfers(tx, plan.transfers)
      let transfersWritten = 0
      for (const { side1, side2 } of transfersToWrite) {
        const created1 = await tx.transaction.create({
          data: {
            date: side1.date,
            amount: side1.amount,
            description: side1.description,
            originalDescription: side1.originalDescription,
            transactionType: 'transfer',
            category: side1.category,
            accountId: side1.accountId,
            status: 'committed',
            rawSource: 'ynab',
            createdVia: 'import',
            ynabId: side1.ynabId,
            transferCounterpartAccountId: side1.transferCounterpartAccountId,
          },
        })
        const created2 = await tx.transaction.create({
          data: {
            date: side2.date,
            amount: side2.amount,
            description: side2.description,
            originalDescription: side2.originalDescription,
            transactionType: 'transfer',
            category: side2.category,
            accountId: side2.accountId,
            status: 'committed',
            rawSource: 'ynab',
            createdVia: 'import',
            ynabId: side2.ynabId,
            transferCounterpartAccountId: side2.transferCounterpartAccountId,
            linkedTransferId: created1.id,
          },
        })
        await tx.transaction.update({ where: { id: created1.id }, data: { linkedTransferId: created2.id } })
        transfersWritten++
        countsByAccount.set(side1.accountId, (countsByAccount.get(side1.accountId) ?? 0) + 1)
        countsByAccount.set(side2.accountId, (countsByAccount.get(side2.accountId) ?? 0) + 1)
      }

      // One ImportRecord per touched account, so a YNAB pull shows up in the
      // same Import History list as a statement upload. Counts are derived from
      // the rows actually written, not from the plan, so the history can't
      // claim more than landed.
      for (const [accountId, transactionCount] of countsByAccount) {
        await tx.importRecord.create({
          data: { filename: importLabel, accountId, transactionCount, importedAt },
        })
      }

      // Persist the cursor and the mapping the user just confirmed.
      await tx.setting.upsert({
        where: { key: YNAB_SERVER_KNOWLEDGE_KEY },
        update: { value: plan.serverKnowledge },
        create: { key: YNAB_SERVER_KNOWLEDGE_KEY, value: plan.serverKnowledge },
      })
      const mapJson = JSON.stringify(accountMap)
      await tx.setting.upsert({
        where: { key: YNAB_ACCOUNT_MAP_KEY },
        update: { value: mapJson },
        create: { key: YNAB_ACCOUNT_MAP_KEY, value: mapJson },
      })

      return {
        count: result.count + transfersWritten * 2,
        accounts: countsByAccount.size,
        transfers: transfersWritten,
      }
    })

    // `planned` is what the plan intended to write; `imported` is what the DB
    // actually accepted. They differ only if skipDuplicates caught something,
    // which is worth showing rather than hiding.
    const { count: planned, ...summary } = summarisePlan(plan)
    return NextResponse.json({
      imported: imported.count,
      transfersImported: imported.transfers,
      planned,
      accounts: imported.accounts,
      categoriesTouched: categoryNames.length,
      ...summary,
    })
  } catch (err) {
    console.error('[ynab] import commit failed and rolled back:', err)
    return NextResponse.json(
      { error: 'The import failed and was rolled back — nothing was written' },
      { status: 500 },
    )
  }
}
