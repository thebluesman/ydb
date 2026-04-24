import path from 'node:path'
import Database from 'better-sqlite3'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'

const DB_PATH = path.join(process.cwd(), 'prisma/dev.db')

function createPrismaClient() {
  const adapter = new PrismaBetterSqlite3({ url: DB_PATH })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// ── Read-only connection for LLM-generated queries ──────────────────────────
// Guarantees that even if an LLM produces INSERT/UPDATE/DELETE/DROP, the
// SQLite driver rejects it at the connection level.

const globalForReadonly = globalThis as unknown as { readonlyDb: Database.Database }

function getReadonlyDb(): Database.Database {
  if (!globalForReadonly.readonlyDb) {
    // timeout: busy-wait up to 2s if the file is locked by a writer.
    globalForReadonly.readonlyDb = new Database(DB_PATH, { readonly: true, timeout: 2000 })
  }
  return globalForReadonly.readonlyDb
}

// Tables the chat LLM is not allowed to read. Matched as identifier tokens,
// not substrings — so "%setting%" inside a string literal on Description
// doesn't trigger a false positive.
const FORBIDDEN_IDENTIFIERS = [
  'setting',
  'chatmessage',
  'chatsession',
  'vendorrule',
  'budget',
  'sqlite_master',
  'sqlite_temp_master',
  'sqlite_schema',
  'sqlite_temp_schema',
  'sqlite_sequence',
]

// Strip string literals ('...') and comments (-- ..., /* ... */) before
// inspecting a SQL string. Avoids matching forbidden names that appear
// inside user-visible description text or commentary.
function stripLiteralsAndComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]

    // block comment
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    // line comment
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end === -1 ? sql.length : end + 1
      continue
    }
    // single-quoted literal (SQL doubles '' for escape)
    if (c === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      continue
    }
    // double-quoted identifier is allowed — but we want its contents to be
    // matched as a real identifier (so `"Setting"` still trips the guard).
    // So we keep quoted identifiers in the output unchanged.
    out += c
    i++
  }
  return out
}

export class ReadonlyQueryError extends Error {}

/**
 * Execute a SELECT (or WITH...SELECT) query on a read-only database
 * connection. Rejects queries that reference sensitive tables or that
 * aren't a read at all.
 */
export function executeReadonlyQuery(sql: string): unknown[] {
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
    throw new ReadonlyQueryError('Only SELECT or WITH ... SELECT statements are allowed')
  }

  const sanitized = stripLiteralsAndComments(trimmed).toLowerCase()
  for (const id of FORBIDDEN_IDENTIFIERS) {
    // Word-boundary match: reject `setting` as a standalone token but allow
    // `settings_import`, `xyz_setting_tbl`, etc. Quoted identifiers like
    // "Setting" also match because `"` counts as a non-word boundary.
    const re = new RegExp(`(^|[^a-z0-9_])${id}([^a-z0-9_]|$)`, 'i')
    if (re.test(sanitized)) {
      throw new ReadonlyQueryError(`Access to "${id}" is not allowed`)
    }
  }

  const db = getReadonlyDb()
  const stmt = db.prepare(trimmed)
  return stmt.all()
}
