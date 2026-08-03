import path from 'node:path'
import Database from 'better-sqlite3'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'

const DB_PATH = path.join(process.cwd(), 'prisma/dev.db')

function createPrismaClient() {
  const adapter = new PrismaBetterSqlite3({ url: DB_PATH })

  // Tune SQLite for concurrent read/write access. journal_mode=WAL is
  // persisted in the database file itself, but synchronous, busy_timeout,
  // and foreign_keys are per-connection — they must be set on the exact
  // better-sqlite3 connection Prisma issues queries through, not a
  // throwaway one that gets closed before Prisma ever touches it.
  //
  // The installed @prisma/adapter-better-sqlite3 has no way to hand it a
  // pre-configured Database instance — its constructor only takes
  // `{ url, ...Options }` (readonly/fileMustExist/timeout/verbose/
  // nativeBinding), and internally it always builds its own connection in
  // connect(). So we wrap connect() and apply the pragmas to the
  // connection it just created, before Prisma gets to use it.
  const originalConnect = adapter.connect.bind(adapter)
  adapter.connect = async () => {
    const conn = await originalConnect()
    const client = (conn as unknown as { client: Database.Database }).client
    client.pragma('journal_mode = WAL')
    client.pragma('synchronous = NORMAL')
    client.pragma('busy_timeout = 5000')
    client.pragma('foreign_keys = ON')
    return conn
  }

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

// A result-column or table ALIAS the model names after `AS` is a label, not an
// identifier reference — `SUM(amount) AS budget` never reads the Budget table,
// and `FROM "Transaction" AS setting` never reads the Setting table. Matching
// FORBIDDEN_IDENTIFIERS as bare tokens anywhere in the SQL can't tell an alias
// target from a real reference, so a query that only ever touches Transaction
// got rejected purely for choosing an unlucky output column name ([chat-bug]
// budget/setting false positive). Masked out before the identifier scan runs,
// same quoting styles ADR-0010's alias detector recognises
// (`lib/chatBalanceScope.ts`'s ALIAS_RE) — bare, "double", `backtick`, [bracket]
// and 'single' quoted, so the model can name a column anything without
// tripping this guard. What precedes `AS` is left untouched: `FROM Budget AS b`
// still has "Budget" itself unmasked and still gets rejected, since that is a
// genuine table reference, not a label.
const ALIAS_DEF_RE = /\bAS\s+(?:"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))/gi

function maskAliasDefinitions(sql: string): string {
  return sql.replace(ALIAS_DEF_RE, (_match, dq, bt, br, sq, bare) => {
    if (dq !== undefined) return `AS "${'_'.repeat(dq.length)}"`
    if (bt !== undefined) return `AS \`${'_'.repeat(bt.length)}\``
    if (br !== undefined) return `AS [${'_'.repeat(br.length)}]`
    if (sq !== undefined) return `AS '${'_'.repeat(sq.length)}'`
    return `AS ${'_'.repeat((bare as string).length)}`
  })
}

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

// Hard cap on rows materialised from an LLM-generated query. A model that omits
// the requested LIMIT (or asks for a huge one) could otherwise pull an entire
// table into JSON and blow the response/token budget. We iterate rather than
// stmt.all() so we stop reading after the cap instead of buffering everything.
export const READONLY_ROW_CAP = 500

export type ReadonlyQueryResult = { rows: unknown[]; truncated: boolean }

/**
 * Execute a SELECT (or WITH...SELECT) query on a read-only database
 * connection. Rejects queries that reference sensitive tables or that
 * aren't a read at all. Caps the result at READONLY_ROW_CAP rows, returning
 * `{ rows, truncated }` so callers can tell the user the result was cut off.
 */
export function executeReadonlyQuery(sql: string): ReadonlyQueryResult {
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
    throw new ReadonlyQueryError('Only SELECT or WITH ... SELECT statements are allowed')
  }

  const sanitized = stripLiteralsAndComments(maskAliasDefinitions(trimmed)).toLowerCase()
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
  // Non-row-returning statements (shouldn't reach here given the SELECT/WITH
  // guard, but defensive) can't be iterated — fall back to run().
  if (!stmt.reader) {
    stmt.run()
    return { rows: [], truncated: false }
  }
  const rows: unknown[] = []
  let truncated = false
  for (const row of stmt.iterate()) {
    if (rows.length >= READONLY_ROW_CAP) { truncated = true; break }
    rows.push(row)
  }
  return { rows, truncated }
}
