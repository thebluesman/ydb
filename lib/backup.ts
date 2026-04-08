import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const DB_PATH = path.join(process.cwd(), 'prisma/dev.db')
const BACKUP_DIR = path.join(process.cwd(), 'backups')
const MAX_BACKUPS = 14

export type BackupEntry = {
  filename: string
  createdAt: string  // ISO string
  sizeBytes: number
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

export function listBackups(): BackupEntry[] {
  ensureBackupDir()
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('ydb-') && f.endsWith('.db'))
    .map((filename) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, filename))
      return { filename, createdAt: stat.birthtime.toISOString(), sizeBytes: stat.size }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function createBackup(): BackupEntry {
  ensureBackupDir()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const filename = `ydb-${timestamp}.db`
  const destPath = path.join(BACKUP_DIR, filename)

  const db = new Database(DB_PATH, { readonly: true })
  try {
    db.backup(destPath)
  } finally {
    db.close()
  }

  pruneOldBackups()

  const stat = fs.statSync(destPath)
  return { filename, createdAt: stat.birthtime.toISOString(), sizeBytes: stat.size }
}

function pruneOldBackups() {
  const backups = listBackups()
  const toDelete = backups.slice(MAX_BACKUPS)
  for (const b of toDelete) {
    fs.rmSync(path.join(BACKUP_DIR, b.filename), { force: true })
  }
}

export function backupFilePath(filename: string): string | null {
  // Sanitize: only allow safe filenames
  if (!/^ydb-[\d\-_T]+\.db$/.test(filename)) return null
  const fullPath = path.join(BACKUP_DIR, filename)
  return fs.existsSync(fullPath) ? fullPath : null
}

/** Auto-backup: skip if a backup already exists from today */
export function autoBackupIfNeeded(): void {
  ensureBackupDir()
  const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  const existing = listBackups().find((b) => b.filename.startsWith(`ydb-${today}`))
  if (!existing) createBackup()
}
