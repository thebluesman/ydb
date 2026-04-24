import { NextResponse } from 'next/server'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { backupFilePath } from '@/lib/backup'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params
  const filePath = backupFilePath(filename)
  if (!filePath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const stat = fs.statSync(filePath)
  // Stream the file instead of readFileSync — multi-MB backups would
  // otherwise block the event loop while they were buffered into memory.
  const nodeStream = fs.createReadStream(filePath)
  // Readable.toWeb returns a web ReadableStream<Uint8Array>. The DOM typings
  // Next bundles type this as ReadableStream<any>, so we cast to satisfy
  // Response — the runtime shape is correct.
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(stat.size),
    },
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params
  const filePath = backupFilePath(filename)
  if (!filePath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  fs.rmSync(filePath)
  return NextResponse.json({ ok: true })
}
