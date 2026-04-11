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
    globalForReadonly.readonlyDb = new Database(DB_PATH, { readonly: true })
  }
  return globalForReadonly.readonlyDb
}

const FORBIDDEN_TABLES = ['setting', 'chatmessage', 'chatsession', 'vendorrule', 'budget']

/**
 * Execute a SELECT query on a read-only database connection.
 * Rejects queries that reference sensitive tables.
 */
export function executeReadonlyQuery(sql: string): unknown[] {
  const lower = sql.toLowerCase()
  for (const table of FORBIDDEN_TABLES) {
    if (lower.includes(table)) {
      throw new Error(`Access to table "${table}" is not allowed`)
    }
  }
  const db = getReadonlyDb()
  const stmt = db.prepare(sql)
  return stmt.all()
}
