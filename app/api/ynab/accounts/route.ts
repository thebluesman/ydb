export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchYnabAccounts, YnabError } from '@/lib/ynab'
import { readAccountMap, readServerKnowledge } from '@/lib/ynabImport'

// Backs the mapping step of the "Import from YNAB" flow: the YNAB account list
// to map from, the YDB account list to map to, and any previously-confirmed
// mapping so the form comes up pre-filled instead of blank on every import.
//
// Read-only in both directions — it touches YNAB with a GET and YDB with
// selects only, so it is safe to call speculatively from the UI.
export async function GET() {
  try {
    const [ynabAccounts, ydbAccounts, accountMap, serverKnowledge] = await Promise.all([
      fetchYnabAccounts(),
      prisma.account.findMany({
        where: { isActive: true },
        select: { id: true, name: true, accountType: true, currency: true },
        orderBy: { id: 'asc' },
      }),
      readAccountMap(),
      readServerKnowledge(),
    ])

    return NextResponse.json({
      ynabAccounts: ynabAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        closed: a.closed,
      })),
      ydbAccounts,
      accountMap,
      // The UI uses this only to say "first import" vs "incremental" — the
      // cursor itself is an opaque YNAB counter, not a secret.
      hasImportedBefore: serverKnowledge != null,
    })
  } catch (err) {
    // YnabError messages are written to be user-safe (never contain the token);
    // anything else is replaced with a generic message so an unexpected stack
    // or driver string can't leak through the API.
    if (err instanceof YnabError) {
      return NextResponse.json({ error: err.message }, { status: 502 })
    }
    console.error('[ynab] account load failed:', err)
    return NextResponse.json({ error: 'Could not load YNAB accounts' }, { status: 500 })
  }
}
