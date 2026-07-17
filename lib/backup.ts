import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'

const DB_PATH = path.join(process.cwd(), 'prisma/dev.db')
const BACKUP_DIR = path.join(process.cwd(), 'backups')
const MAX_BACKUPS = 14

/**
 * Locate the prisma CLI. It is not always under `cwd/node_modules` — with
 * hoisted installs, workspaces, or git worktrees the dependency lives in an
 * ancestor's `node_modules`. Walk up from cwd (mirroring Node's own module
 * resolution) and use the first `node_modules/.bin/prisma` that exists,
 * falling back to the cwd-local path so the error message stays meaningful.
 */
function resolvePrismaBin(): string {
  const local = path.join(process.cwd(), 'node_modules/.bin/prisma')
  let dir = process.cwd()
  for (;;) {
    const candidate = path.join(dir, 'node_modules/.bin/prisma')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return local
    dir = parent
  }
}

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

function removeSidecars(dbPath: string) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true })
  }
}

type SchemaMigration = { method: 'migrate-deploy' | 'db-push' }

/** Result of a shelled-out prisma invocation. */
type PrismaResult = { status: number; output: string }

/** Injectable so the behaviour can be unit-tested against a throwaway db. */
export type PrismaRunner = (args: string[]) => PrismaResult

/**
 * Generous but finite: `migrate deploy`/`db push` on a single-user SQLite db
 * should finish in well under a minute. `spawnSync` blocks the whole (single-
 * threaded) Node process for however long the child runs, so a hung or lock-
 * blocked prisma invocation would otherwise freeze every concurrent request
 * with no bound at all.
 */
const PRISMA_RUNNER_TIMEOUT_MS = 60_000

function defaultPrismaRunner(configPath?: string): PrismaRunner {
  return (args) => {
    const fullArgs = configPath ? [...args, '--config', configPath] : args
    const res = spawnSync(resolvePrismaBin(), fullArgs, {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: PRISMA_RUNNER_TIMEOUT_MS,
    })
    return {
      status: res.status ?? 1,
      output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? String(res.error) : ''}`,
    }
  }
}

/**
 * Bring a just-restored database up to the current Prisma schema.
 *
 * A restored snapshot can be older than the newest applied migration, which
 * leaves the live db missing recent columns/tables — the app then 500s (e.g.
 * P2022 "column does not exist") the moment it touches them. So after swapping
 * the file in we reconcile its schema:
 *
 *   1. `prisma migrate deploy` — the normal, migration-history-preserving path.
 *      Works for any backup that carries a `_prisma_migrations` table (the
 *      common case: you restore a recent snapshot). It applies only the
 *      pending migrations and keeps the history intact.
 *   2. If that fails (typically P3005 for a pre-baseline snapshot that has no
 *      `_prisma_migrations` table at all — migrate deploy refuses to touch a
 *      non-empty db it doesn't recognise) we fall back to `prisma db push`,
 *      which force-syncs the schema to match `schema.prisma` regardless of
 *      migration state. Our migrations are additive, so this preserves data.
 *
 * Throws if neither path can reconcile the schema, so the caller can roll the
 * restore back.
 */
export function bringSchemaCurrent(opts?: {
  configPath?: string
  runner?: PrismaRunner
}): SchemaMigration {
  const run = opts?.runner ?? defaultPrismaRunner(opts?.configPath)

  const deploy = run(['migrate', 'deploy'])
  if (deploy.status === 0) return { method: 'migrate-deploy' }

  const push = run(['db', 'push', '--accept-data-loss'])
  if (push.status === 0) return { method: 'db-push' }

  throw new Error(
    `Could not bring the restored database up to the current schema.\n` +
      `migrate deploy failed:\n${deploy.output}\n` +
      `db push failed:\n${push.output}`,
  )
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
 *   4. Reconcile the restored file's schema with the current Prisma schema so
 *      an older snapshot doesn't leave the app 500ing on missing columns.
 *      On failure we automatically roll back to the safety backup taken in
 *      step 1 — the whole point of this feature is that a restore can't leave
 *      you worse off, so we never hand back a half-migrated/broken db and
 *      make the user notice and recover it by hand.
 *
 * The running process keeps its existing SQLite connections/prepared
 * statements open against the OLD file identity in memory — that's exactly
 * why the caller must prompt for an app restart afterward; this function
 * does not attempt to hot-swap the live Prisma client.
 */
export async function restoreBackup(
  filename: string,
): Promise<{ safetyBackup: BackupEntry; schemaMigration: SchemaMigration }> {
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
  removeSidecars(DB_PATH)

  fs.copyFileSync(srcPath, DB_PATH)

  let schemaMigration: SchemaMigration
  try {
    schemaMigration = bringSchemaCurrent()
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    // Auto-rollback: put the pre-restore db back exactly as it was so the
    // user is never left with a broken schema. The safety backup was taken
    // from the (healthy, fully-migrated) live db moments ago. This copy is
    // wrapped in its own try/catch so a failure here (e.g. disk full) still
    // surfaces a clear, actionable message instead of an unrelated raw fs
    // error preempting the intended rollback-status report.
    try {
      removeSidecars(DB_PATH)
      fs.copyFileSync(path.join(BACKUP_DIR, safetyBackup.filename), DB_PATH)
    } catch (rollbackErr) {
      const rollbackCause = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      throw new Error(
        `Restore aborted: could not migrate "${filename}" to the current schema (${cause}). ` +
          `Rollback to the pre-restore database ALSO failed (${rollbackCause}) — dev.db may be ` +
          `in a broken intermediate state. Manually restore from backups/${safetyBackup.filename}.`,
      )
    }
    throw new Error(
      `Restore aborted: could not migrate "${filename}" to the current schema. ` +
        `Rolled back to the pre-restore database (safety backup ${safetyBackup.filename}). ` +
        `Cause: ${cause}`,
    )
  }

  return { safetyBackup, schemaMigration }
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
