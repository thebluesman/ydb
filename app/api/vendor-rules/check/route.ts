import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const description = searchParams.get('description') ?? ''
  const rules = await prisma.vendorRule.findMany()
  const matched = rules.some((r) =>
    description.toLowerCase().includes(r.pattern.toLowerCase())
  )
  return NextResponse.json({ matched })
}
