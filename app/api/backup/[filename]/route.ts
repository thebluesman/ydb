import { NextResponse } from 'next/server'
import fs from 'node:fs'
import { backupFilePath } from '@/lib/backup'

export async function GET(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params
  const filePath = backupFilePath(filename)
  if (!filePath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const buffer = fs.readFileSync(filePath)
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.byteLength),
    },
  })
}
