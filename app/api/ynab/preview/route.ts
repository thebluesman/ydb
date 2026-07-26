export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { YnabError } from '@/lib/ynab'
import {
  planYnabImport,
  summarisePlan,
  validateAccountMap,
  type YnabAccountMap,
} from '@/lib/ynabImport'

// Dry run for the confirm-before-commit modal. Resolves exactly what
// /api/ynab/import would write — same fetch, same mapping, same
// already-imported filter — and returns a summary without touching the ledger,
// the delta cursor, or the saved account map.
//
// Nothing here writes, so the preview is repeatable: the user can preview as
// many times as they like without consuming the delta cursor.
export async function POST(request: Request) {
  let body: { accountMap?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 })
  }

  const invalid = await validateAccountMap(body.accountMap)
  if (invalid) return NextResponse.json(invalid, { status: 400 })

  try {
    const plan = await planYnabImport(body.accountMap as YnabAccountMap)
    return NextResponse.json(summarisePlan(plan))
  } catch (err) {
    if (err instanceof YnabError) {
      return NextResponse.json({ error: err.message }, { status: 502 })
    }
    // Anything reaching here is a local/DB fault, not a YNAB one — the access
    // token never enters this path (it lives only in lib/ynab.ts request
    // headers), so logging the error server-side cannot leak it. Without this
    // the client just sees a generic 500 with nothing to debug from.
    console.error('[ynab] preview failed:', err)
    return NextResponse.json({ error: 'Could not preview the YNAB import' }, { status: 500 })
  }
}
