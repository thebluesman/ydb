import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

type ClearScope = {
  transactions?: boolean
  importHistory?: boolean
  accounts?: boolean
  categories?: boolean
  patterns?: boolean
  chatHistory?: boolean
}

export async function DELETE(request: Request) {
  let scope: ClearScope = {}
  try {
    scope = await request.json()
  } catch {
    // No body — treat as clear everything (backward compatibility)
    scope = { transactions: true, importHistory: true, accounts: true, categories: true, patterns: true, chatHistory: true }
  }

  // Chat messages first (child of ChatSession)
  if (scope.chatHistory) {
    await prisma.chatMessage.deleteMany()
    await prisma.chatSession.deleteMany()
  }

  // Budgets are logically tied to categories
  if (scope.categories) {
    await prisma.budget.deleteMany()
  }

  // ImportRecords reference accounts — delete before accounts
  if (scope.importHistory || scope.accounts) {
    await prisma.importRecord.deleteMany()
  }

  // Transactions reference accounts — delete before accounts
  if (scope.transactions || scope.accounts) {
    await prisma.transaction.deleteMany()
  }

  if (scope.patterns) {
    await prisma.vendorRule.deleteMany()
  }

  if (scope.categories) {
    await prisma.category.deleteMany()
  }

  // Accounts last — other tables reference accountId
  if (scope.accounts) {
    await prisma.account.deleteMany()
  }

  return NextResponse.json({ ok: true })
}
