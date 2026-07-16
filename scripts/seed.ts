// Seed script (IMPROVEMENT_PLAN Phase 8) — generates realistic accounts and
// ~50k transactions (splits, transfers, reimbursements included) so the
// ledger/dashboard queries built in Phases 1–2 can be load-tested at a
// realistic multi-year size. Run with `npm run seed`.
//
// Deliberately writes straight through Prisma's `createMany` in batches
// rather than going through the API/validation layer — this is a fixture
// generator, not a simulation of user input, and needs to run fast for 50k
// rows. It DOES follow the sign/type rules in lib/accounts.ts and
// lib/transactionValidation.ts by construction (see `debit`/`credit`/
// `transfer` helpers below), so seeded data is a valid representation of
// what those rules allow.
//
// Idempotent-ish: re-running wipes existing seed-owned rows first (any
// Account whose name starts with the SEED_PREFIX) rather than the whole
// table, so it's safe to run against a DB that also has real data.

import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import Database from 'better-sqlite3'
import path from 'node:path'

const DB_PATH = path.join(process.cwd(), 'prisma/dev.db')
const adapter = new PrismaBetterSqlite3({ url: DB_PATH })

// Transfer pairs, reimbursement expense/settlement pairs, and split
// parent/leg rows reference each other's ids (linkedTransferId,
// reimbursementTxId, parentTransactionId). Both sides of a pair are assigned
// their ids up front (see nextId()) and inserted together in one createMany
// batch, which means the row inserted first always forward-references a row
// that doesn't exist in the table yet — SQLite checks FK constraints
// per-row, so that fails with `foreign_keys = ON` (which lib/prisma.ts's
// runtime connection enables, and this adapter may too). This script is a
// bulk fixture loader that constructs every id itself and knows the full set
// is internally consistent by construction, so it disables FK enforcement
// for its own connection only, then runs `PRAGMA foreign_key_check` at the
// end as a real verification (not just an assumption) that nothing is
// actually dangling before it reports success.
const originalConnect = adapter.connect.bind(adapter)
adapter.connect = async () => {
  const conn = await originalConnect()
  const client = (conn as unknown as { client: Database.Database }).client
  client.pragma('foreign_keys = OFF')
  return conn
}
const prisma = new PrismaClient({ adapter })

const SEED_PREFIX = '[seed] '
const TARGET_TRANSACTION_COUNT = 50_000
const BATCH_SIZE = 2_000

// Small seeded PRNG so re-runs are reproducible (helps debugging perf
// regressions against a stable dataset instead of a different random one
// each time).
function mulberry32(seed: number) {
  let a = seed
  return function rand() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260716)

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min
}
function chance(p: number): boolean {
  return rand() < p
}

// ── Accounts ─────────────────────────────────────────────────────────────
// Covers every account type in lib/accounts.ts: asset (current) and
// liability (credit, personal_loan, auto_loan) so the seeded ledger exercises
// both sign conventions.
type SeedAccountDef = {
  name: string
  accountType: 'current' | 'savings' | 'credit' | 'personal_loan' | 'auto_loan'
  currency: string
  openingBalance: number // cents
  creditLimit?: number
}

const ACCOUNT_DEFS: SeedAccountDef[] = [
  { name: `${SEED_PREFIX}Current Account`, accountType: 'current', currency: 'GBP', openingBalance: 250_000 },
  { name: `${SEED_PREFIX}Savings Account`, accountType: 'savings', currency: 'GBP', openingBalance: 1_500_000 },
  { name: `${SEED_PREFIX}Credit Card`, accountType: 'credit', currency: 'GBP', openingBalance: 0, creditLimit: 500_000 },
  { name: `${SEED_PREFIX}Personal Loan`, accountType: 'personal_loan', currency: 'GBP', openingBalance: -1_200_000 },
  { name: `${SEED_PREFIX}Auto Loan`, accountType: 'auto_loan', currency: 'GBP', openingBalance: -800_000 },
]

const CATEGORIES = [
  'Groceries', 'Dining', 'Transport', 'Entertainment', 'Shopping', 'Utilities',
  'Rent', 'Health', 'Travel', 'Subscriptions', 'Income', 'Insurance', 'Fees',
  'Reimbursement', 'Education', 'Fitness',
]

const MERCHANTS_BY_CATEGORY: Record<string, string[]> = {
  Groceries: ['TESCO STORES', 'SAINSBURYS', 'WAITROSE', 'ALDI', 'LIDL'],
  Dining: ['PRET A MANGER', 'NANDOS', 'DELIVEROO', 'UBER EATS', 'COSTA COFFEE'],
  Transport: ['TFL TRAVEL', 'UBER TRIP', 'TRAINLINE', 'SHELL PETROL', 'BP FUEL'],
  Entertainment: ['NETFLIX', 'CINEMA WORLD', 'SPOTIFY', 'STEAM GAMES', 'PLAYSTATION STORE'],
  Shopping: ['AMAZON MARKETPLACE', 'ARGOS', 'JOHN LEWIS', 'IKEA', 'ZARA'],
  Utilities: ['BRITISH GAS', 'THAMES WATER', 'EDF ENERGY', 'BT BROADBAND', 'O2 MOBILE'],
  Rent: ['LANDLORD RENT PAYMENT'],
  Health: ['BOOTS PHARMACY', 'NUFFIELD HEALTH', 'DENTAL PRACTICE', 'SPECSAVERS'],
  Travel: ['BRITISH AIRWAYS', 'EASYJET', 'BOOKING.COM', 'AIRBNB', 'NATIONAL EXPRESS'],
  Subscriptions: ['AMAZON PRIME', 'APPLE.COM/BILL', 'DISNEY PLUS', 'GYM MEMBERSHIP'],
  Income: ['ACME CORP PAYROLL', 'FREELANCE INVOICE PAYMENT'],
  Insurance: ['AVIVA INSURANCE', 'ADMIRAL INSURANCE', 'VITALITY HEALTH'],
  Fees: ['BANK MONTHLY FEE', 'ATM WITHDRAWAL FEE', 'FOREIGN TRANSACTION FEE'],
  Reimbursement: ['EMPLOYER EXPENSE REIMBURSEMENT', 'INSURANCE CLAIM PAYOUT'],
  Education: ['UDEMY COURSE', 'OPEN UNIVERSITY FEES', 'LOCAL LIBRARY'],
  Fitness: ['PURE GYM', 'PELOTON MEMBERSHIP', 'LOCAL SPORTS CENTRE'],
}

const EXPENSE_CATEGORIES = CATEGORIES.filter((c) => c !== 'Income')

async function main() {
  console.log(`Seeding against ${DB_PATH} …`)

  await wipeExistingSeedData()
  await initIdCounter()

  const accounts = await createAccounts()
  console.log(`Created ${accounts.length} seed accounts.`)

  const current = accounts.find((a) => a.accountType === 'current')!
  const savings = accounts.find((a) => a.accountType === 'savings')!
  const credit = accounts.find((a) => a.accountType === 'credit')!
  const loanAccounts = accounts.filter((a) => a.accountType === 'personal_loan' || a.accountType === 'auto_loan')

  const startDate = new Date()
  startDate.setUTCFullYear(startDate.getUTCFullYear() - 3) // 3 years of history

  let created = 0
  let batch: TxInsert[] = []
  const flush = async () => {
    if (batch.length === 0) return
    await prisma.transaction.createMany({ data: batch })
    created += batch.length
    batch = []
  }

  // Walk day by day across the range, emitting a plausible mix of rows so
  // the date distribution is roughly uniform rather than clustered — this
  // matters for the dashboard's monthly grouping and the ledger's date
  // filter to have something realistic to query against.
  const dayMs = 24 * 60 * 60 * 1000
  const totalDays = Math.round((Date.now() - startDate.getTime()) / dayMs)
  // Aim for TARGET_TRANSACTION_COUNT total rows including splits/transfers/
  // reimbursement settlements — a bit more than 1 "base" row per account
  // per day across 3 accounts that see day-to-day activity.
  const baseRowsPerDay = Math.max(1, Math.round(TARGET_TRANSACTION_COUNT / totalDays / 1.15))

  for (let d = 0; d < totalDays && created < TARGET_TRANSACTION_COUNT; d++) {
    const date = new Date(startDate.getTime() + d * dayMs)

    // Monthly payroll on the 1st into the current account.
    if (date.getUTCDate() === 1) {
      batch.push(credit_(current.id, date, 'ACME CORP PAYROLL', 'Income', randInt(280_000, 340_000)))
    }
    // Monthly rent on the 3rd.
    if (date.getUTCDate() === 3) {
      batch.push(debit_(current.id, date, 'LANDLORD RENT PAYMENT', 'Rent', -randInt(90_000, 120_000)))
    }
    // Monthly credit-card statement payment (transfer current → credit) on the 15th.
    if (date.getUTCDate() === 15) {
      const amount = randInt(20_000, 150_000)
      pushTransferPair(batch, current, credit, date, amount)
    }
    // Occasional loan repayments (transfer current → loan account) on the 5th.
    if (date.getUTCDate() === 5) {
      for (const loan of loanAccounts) {
        pushTransferPair(batch, current, loan, date, randInt(15_000, 40_000))
      }
    }
    // Occasional savings top-up.
    if (chance(0.1)) {
      pushTransferPair(batch, current, savings, date, randInt(5_000, 50_000))
    }

    // Day-to-day spend split across current + credit card.
    const rowsToday = randInt(0, Math.max(1, baseRowsPerDay * 2))
    for (let i = 0; i < rowsToday; i++) {
      const account = chance(0.55) ? credit : current
      const category = pick(EXPENSE_CATEGORIES)
      const merchant = pick(MERCHANTS_BY_CATEGORY[category])
      const amountCents = -randInt(300, 25_000)
      const row = debit_(account.id, date, merchant, category, amountCents)

      if (chance(0.03)) {
        // Split transaction: parent placeholder + 2-3 legs across
        // categories that sum to the parent's amount.
        pushSplit(batch, account.id, date, merchant, amountCents)
        continue
      }

      if (chance(0.02)) {
        // Reimbursable expense: mark it, and ~70% of the time also emit the
        // matching settlement credit a few days later (pending the rest of
        // the time so the ledger's pending-reimbursements banner has data).
        const reimbId = nextId()
        row.reimbursableFor = 'Employer'
        row.id = reimbId
        batch.push(row)
        if (chance(0.7)) {
          const settleDate = new Date(date.getTime() + randInt(3, 20) * dayMs)
          const settlement = credit_(
            account.id,
            settleDate,
            'EMPLOYER EXPENSE REIMBURSEMENT',
            'Reimbursement',
            Math.abs(amountCents),
          )
          const settlementId = nextId()
          settlement.id = settlementId
          batch.push(settlement)
          row.reimbursementTxId = settlementId
        }
        continue
      }

      batch.push(row)
    }

    if (batch.length >= BATCH_SIZE) {
      await flush()
      if (created % 10_000 < BATCH_SIZE) console.log(`  ${created} transactions…`)
    }
  }
  await flush()

  console.log(`Inserted ${created} transactions.`)

  await verifyReferentialIntegrity()
  console.log('Done.')
}

// Real verification (not an assumption) that turning off FK enforcement
// above didn't let anything genuinely dangling through.
async function verifyReferentialIntegrity() {
  const violations = await prisma.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check')
  if (violations.length > 0) {
    console.error(`foreign_key_check found ${violations.length} violation(s):`, violations.slice(0, 10))
    throw new Error('Seed data failed referential integrity check')
  }
  console.log('foreign_key_check: OK, no violations.')
}

// ── Row builders ─────────────────────────────────────────────────────────
// Mirrors lib/transactionValidation.ts: debit amount <= 0, credit amount >= 0,
// transfer sign free but paired with a real counterpart.

type TxInsert = {
  id?: number
  date: Date
  amount: number
  description: string
  originalDescription: string | null
  transactionType: 'debit' | 'credit' | 'transfer'
  category: string
  accountId: number
  status: string
  createdVia: string
  reimbursableFor?: string | null
  reimbursementTxId?: number | null
  transferCounterpartAccountId?: number | null
  linkedTransferId?: number | null
  parentTransactionId?: number | null
}

// Explicit id sequencing for EVERY inserted row (not just paired ones): we
// need to wire up reimbursementTxId/linkedTransferId pairs within a batch
// before the rows are inserted (createMany doesn't hand back generated ids),
// which means some rows in a batch carry an explicit `id` and, without care,
// others would fall back to SQLite's auto-assigned rowid — the two schemes
// can collide (autoincrement doesn't know about ids this script has already
// "reserved" for a later row in the same or a subsequent batch). So instead
// every row gets an explicit id from one monotonic counter, seeded above the
// current max Transaction id (initIdCounter) so it can never collide with
// pre-existing rows either.
let idCounter = 1
function nextId(): number {
  return idCounter++
}

async function initIdCounter() {
  const max = await prisma.transaction.aggregate({ _max: { id: true } })
  idCounter = (max._max.id ?? 0) + 1
}

function debit_(accountId: number, date: Date, merchant: string, category: string, amountCents: number): TxInsert {
  return {
    id: nextId(),
    date,
    amount: -Math.abs(amountCents),
    description: merchant,
    originalDescription: merchant,
    transactionType: 'debit',
    category,
    accountId,
    status: 'committed',
    createdVia: 'import',
  }
}

function credit_(accountId: number, date: Date, merchant: string, category: string, amountCents: number): TxInsert {
  return {
    id: nextId(),
    date,
    amount: Math.abs(amountCents),
    description: merchant,
    originalDescription: merchant,
    transactionType: 'credit',
    category,
    accountId,
    status: 'committed',
    createdVia: 'import',
  }
}

function pushTransferPair(
  batch: TxInsert[],
  from: { id: number },
  to: { id: number },
  date: Date,
  amountCents: number,
) {
  const outId = nextId()
  const inId = nextId()
  batch.push({
    id: outId,
    date,
    amount: -amountCents,
    description: 'Transfer out',
    originalDescription: null,
    transactionType: 'transfer',
    category: '',
    accountId: from.id,
    status: 'committed',
    createdVia: 'manual',
    transferCounterpartAccountId: to.id,
    linkedTransferId: inId,
  })
  batch.push({
    id: inId,
    date,
    amount: amountCents,
    description: 'Transfer in',
    originalDescription: null,
    transactionType: 'transfer',
    category: '',
    accountId: to.id,
    status: 'committed',
    createdVia: 'manual',
    transferCounterpartAccountId: from.id,
    linkedTransferId: outId,
  })
}

function pushSplit(batch: TxInsert[], accountId: number, date: Date, merchant: string, totalAmountCents: number) {
  const parentId = nextId()
  const legCount = randInt(2, 3)
  const total = Math.abs(totalAmountCents)
  const shares = splitShares(total, legCount)
  const legCategories = Array.from({ length: legCount }, () => pick(EXPENSE_CATEGORIES))

  batch.push({
    id: parentId,
    date,
    amount: -total,
    description: merchant,
    originalDescription: merchant,
    transactionType: 'debit',
    category: legCategories[0],
    accountId,
    status: 'committed',
    createdVia: 'import',
  })
  for (let i = 0; i < legCount; i++) {
    batch.push({
      id: nextId(),
      date,
      amount: -shares[i],
      description: `${merchant} (split)`,
      originalDescription: null,
      transactionType: 'debit',
      category: legCategories[i],
      accountId,
      status: 'committed',
      createdVia: 'manual',
      parentTransactionId: parentId,
    })
  }
}

function splitShares(total: number, n: number): number[] {
  const shares: number[] = []
  let remaining = total
  for (let i = 0; i < n - 1; i++) {
    const share = Math.max(1, Math.round((remaining / (n - i)) * (0.6 + rand() * 0.8)))
    shares.push(Math.min(share, remaining - (n - i - 1)))
    remaining -= shares[i]
  }
  shares.push(remaining)
  return shares
}

async function wipeExistingSeedData() {
  const existing = await prisma.account.findMany({
    where: { name: { startsWith: SEED_PREFIX } },
    select: { id: true },
  })
  if (existing.length === 0) return
  const ids = existing.map((a) => a.id)
  console.log(`Removing ${ids.length} previously-seeded accounts and their transactions…`)
  // Split legs/transfers/reimbursements all reference Transaction rows via
  // FKs with onDelete Cascade/SetNull already declared in schema.prisma, but
  // deleting transactions before accounts keeps this script correct even if
  // that ever changes.
  await prisma.transaction.deleteMany({ where: { accountId: { in: ids } } })
  await prisma.account.deleteMany({ where: { id: { in: ids } } })
}

async function createAccounts() {
  const accounts = []
  for (const def of ACCOUNT_DEFS) {
    const account = await prisma.account.create({
      data: {
        name: def.name,
        accountType: def.accountType,
        currency: def.currency,
        openingBalance: def.openingBalance,
        openingBalanceDate: (() => {
          const d = new Date()
          d.setUTCFullYear(d.getUTCFullYear() - 3)
          return d
        })(),
        creditLimit: def.creditLimit ?? null,
        isActive: true,
      },
    })
    accounts.push({ ...account, accountType: def.accountType })
  }
  return accounts
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
