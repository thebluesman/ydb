import { NextResponse } from 'next/server'
import { listBackups, createBackup } from '@/lib/backup'

export async function GET() {
  try {
    const backups = listBackups()
    return NextResponse.json({ backups })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST() {
  try {
    const entry = await createBackup()
    return NextResponse.json({ backup: entry })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
