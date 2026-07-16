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

export async function createBackup(): Promise<BackupEntry> {
  ensureBackupDir()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const filename = `ydb-${timestamp}.db`
  const destPath = path.join(BACKUP_DIR, filename)

  const db = new Database(DB_PATH, { readonly: true })
  try {
    await db.backup(destPath)
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

/**
 * Restore the live database from a stored snapshot (IMPROVEMENT_PLAN Phase 7
 * item 3). Steps, in order:
 *   1. Safety-backup the CURRENT dev.db first, so a bad restore is itself
 *      recoverable.
 *   2. Checkpoint the live connection's WAL into the main db file (dev.db is
 *      opened elsewhere in this process in WAL mode — copying the file
 *      without checkpointing first would silently drop whatever's still only
 *      in -wal) and remove the now-empty -wal/-shm sidecar files so they
 *      can't reference stale pages after the swap.
 *   3. Copy the chosen snapshot over dev.db.
 *
 * The running process keeps its existing SQLite connections/prepared
 * statements open against the OLD file identity in memory — that's exactly
 * why the caller must prompt for an app restart afterward; this function
 * does not attempt to hot-swap the live Prisma client.
 */
export async function restoreBackup(filename: string): Promise<{ safetyBackup: BackupEntry }> {
  const srcPath = backupFilePath(filename)
  if (!srcPath) throw new Error('Backup not found')

  const safetyBackup = await createBackup()

  if (fs.existsSync(DB_PATH)) {
    try {
      const live = new Database(DB_PATH)
      live.pragma('wal_checkpoint(TRUNCATE)')
      live.close()
    } catch {
      // Best-effort — proceed with the file copy even if the live DB
      // couldn't be opened/checkpointed (e.g. locked); the safety backup
      // above still protects the pre-restore state.
    }
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${DB_PATH}${suffix}`
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true })
  }

  fs.copyFileSync(srcPath, DB_PATH)

  return { safetyBackup }
}

export function backupFilePath(filename: string): string | null {
  // Sanitize: only allow safe filenames
  if (!/^ydb-[\d\-_T]+\.db$/.test(filename)) return null
  const fullPath = path.join(BACKUP_DIR, filename)
  return fs.existsSync(fullPath) ? fullPath : null
}

/** Auto-backup: skip if a backup already exists from today */
export async function autoBackupIfNeeded(): Promise<void> {
  ensureBackupDir()
  const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  const existing = listBackups().find((b) => b.filename.startsWith(`ydb-${today}`))
  if (!existing) await createBackup()
}
