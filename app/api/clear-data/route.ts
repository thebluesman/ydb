import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

const CONFIRMATION_PHRASE = 'DELETE ALL DATA'

type ClearScope = {
  transactions?: boolean
  importHistory?: boolean
  accounts?: boolean
  categories?: boolean
  patterns?: boolean
  chatHistory?: boolean
}

export async function DELETE(request: Request) {
  let body: { confirmation?: string; scope?: ClearScope } = {}
  try {
    body = await request.json()
  } catch {
    // empty/invalid body handled by the confirmation check below
  }

  if (body.confirmation !== CONFIRMATION_PHRASE) {
    return NextResponse.json(
      { error: `confirmation required — send { "confirmation": "${CONFIRMATION_PHRASE}", "scope": {...} }` },
      { status: 400 }
    )
  }

  const scope: ClearScope = body.scope ?? {
    transactions: true,
    importHistory: true,
    accounts: true,
    categories: true,
    patterns: true,
    chatHistory: true,
  }

  // Order matters — child rows before parents (FKs) — but $transaction rolls back
  // on any failure so partial deletes can't leave the DB in a half-wiped state.
  const ops = []

  if (scope.chatHistory) {
    ops.push(prisma.chatMessage.deleteMany())
    ops.push(prisma.chatSession.deleteMany())
  }
  if (scope.categories) {
    ops.push(prisma.budget.deleteMany())
  }
  if (scope.importHistory || scope.accounts) {
    ops.push(prisma.importRecord.deleteMany())
  }
  if (scope.transactions || scope.accounts) {
    ops.push(prisma.transaction.deleteMany())
  }
  if (scope.patterns) {
    ops.push(prisma.vendorRule.deleteMany())
  }
  if (scope.categories) {
    ops.push(prisma.category.deleteMany())
  }
  if (scope.accounts) {
    ops.push(prisma.account.deleteMany())
  }

  await prisma.$transaction(ops)

  return NextResponse.json({ ok: true })
}
