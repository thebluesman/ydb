import { NextResponse } from 'next/server'
import { restoreBackup, backupFilePath } from '@/lib/backup'

export const runtime = 'nodejs'

export async function POST(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params
  if (!backupFilePath(filename)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  try {
    const { safetyBackup } = await restoreBackup(filename)
    return NextResponse.json({ ok: true, needsRestart: true, safetyBackup })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
