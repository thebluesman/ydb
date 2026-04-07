import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function DELETE() {
  // Order matters — delete child records before parents
  await prisma.transaction.deleteMany()
  await prisma.vendorRule.deleteMany()
  await prisma.category.deleteMany()
  await prisma.account.deleteMany()
  // Leave Settings intact — preferences shouldn't be wiped

  return NextResponse.json({ ok: true })
}
