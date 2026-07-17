import { NextResponse } from 'next/server'
import { getRecurringSeries } from '@/lib/recurring'

export async function GET() {
  const recurring = await getRecurringSeries()
  return NextResponse.json(recurring.sort((a, b) => b.avgAmount - a.avgAmount))
}
