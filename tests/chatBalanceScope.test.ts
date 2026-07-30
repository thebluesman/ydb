import { describe, expect, it } from 'vitest'
import {
  BALANCE_ALIAS_WORDS,
  balanceScopeMessage,
  balanceScopeViolation,
  extractAliases,
} from '@/lib/chatBalanceScope'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0010 unit coverage: the guard fires on the model's own result label, and
// on any reference to Account.openingBalance. Route-level wiring (both passes,
// short-circuit, refusal shape) is tests/chatBalanceScopeRoute.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Session 10's query, verbatim — the ADR's named regression fixture. */
const SESSION_10_SQL =
  `SELECT Account.name, SUM("Transaction".amount) / 100.0 AS total_balance ` +
  `FROM "Transaction" JOIN Account ON "Transaction".accountId = Account.id ` +
  `WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) ` +
  `AND Account.accountType = 'loan' GROUP BY Account.name LIMIT 200`

describe('balanceScopeViolation — openingBalance (ADR-0009, carried over)', () => {
  it('(a) rejects a query that selects Account.openingBalance', () => {
    const v = balanceScopeViolation(
      `SELECT name, openingBalance / 100.0 AS opening FROM Account LIMIT 200`,
    )
    expect(v).toEqual({ kind: 'opening-balance' })
  })

  it('rejects it through a table qualifier and through an aggregate', () => {
    expect(balanceScopeViolation(`SELECT Account.openingBalance FROM Account`)?.kind)
      .toBe('opening-balance')
    expect(balanceScopeViolation(`SELECT SUM(a.openingBalance) AS total FROM Account a`)?.kind)
      .toBe('opening-balance')
  })

  it('rejects openingBalanceDate too — it is the same column family', () => {
    expect(balanceScopeViolation(`SELECT openingBalanceDate FROM Account`)?.kind)
      .toBe('opening-balance')
  })

  it('reports openingBalance ahead of the alias when a query does both', () => {
    // `SELECT openingBalance AS balance` is an openingBalance query first.
    expect(balanceScopeViolation(`SELECT openingBalance AS balance FROM Account`))
      .toEqual({ kind: 'opening-balance' })
  })
})

describe('balanceScopeViolation — balance-asserting aliases (ADR-0010)', () => {
  // (b) each of the four alias words rejected in isolation.
  const cases: Record<string, string> = {
    balance: `SELECT SUM(amount) / 100.0 AS balance FROM "Transaction"`,
    net_worth: `SELECT SUM(amount) / 100.0 AS net_worth FROM "Transaction"`,
    outstanding: `SELECT SUM(amount) / 100.0 AS outstanding FROM "Transaction"`,
    owed: `SELECT SUM(amount) / 100.0 AS owed FROM "Transaction"`,
  }

  for (const word of BALANCE_ALIAS_WORDS) {
    it(`(b) rejects '${word}' as a bare alias`, () => {
      expect(balanceScopeViolation(cases[word])).toMatchObject({ kind: 'balance-alias', word })
    })
  }

  it('rejects the word inside a longer alias', () => {
    for (const alias of ['total_balance', 'current_balance', 'amount_outstanding', 'total_owed']) {
      const v = balanceScopeViolation(`SELECT SUM(amount) AS ${alias} FROM "Transaction"`)
      expect(v?.kind, alias).toBe('balance-alias')
    }
  })

  it('rejects camelCase and quoted aliases', () => {
    expect(balanceScopeViolation(`SELECT SUM(amount) AS netWorth FROM "Transaction"`)?.kind)
      .toBe('balance-alias')
    expect(balanceScopeViolation(`SELECT SUM(amount) AS totalBalance FROM "Transaction"`)?.kind)
      .toBe('balance-alias')
    expect(balanceScopeViolation(`SELECT SUM(amount) AS "Total Balance" FROM "Transaction"`)?.kind)
      .toBe('balance-alias')
    expect(balanceScopeViolation(`SELECT SUM(amount) AS [balance] FROM "Transaction"`)?.kind)
      .toBe('balance-alias')
  })

  it('rejects plurals of the alias words', () => {
    expect(balanceScopeViolation(`SELECT SUM(amount) AS balances FROM "Transaction"`)?.kind)
      .toBe('balance-alias')
  })

  it('rejects an alias buried in a CTE — over-rejection is the safe direction', () => {
    const sql =
      `WITH per_account AS (SELECT accountId, SUM(amount) AS balance FROM "Transaction" GROUP BY accountId) ` +
      `SELECT accountId, balance FROM per_account LIMIT 200`
    expect(balanceScopeViolation(sql)?.kind).toBe('balance-alias')
  })
})

describe('balanceScopeViolation — in-scope queries are untouched', () => {
  it('(c) allows a normal aggregate aliased `total`', () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE strftime('%Y-%m', date) = '2026-06' AND status IN ('committed','reconciled')`
    expect(balanceScopeViolation(sql)).toBeNull()
  })

  it('allows the prompt\'s other worked examples', () => {
    const inScope = [
      `SELECT COUNT(*) AS total FROM "Transaction" WHERE status IN ('committed','reconciled')`,
      `SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" GROUP BY category LIMIT 5`,
      `SELECT Account.name, SUM("Transaction".amount) / 100.0 AS net_flow FROM "Transaction" ` +
        `JOIN Account ON "Transaction".accountId = Account.id GROUP BY Account.name`,
      `SELECT strftime('%Y-%m', date) AS month, SUM(amount) / 100.0 AS spent FROM "Transaction" GROUP BY month`,
    ]
    for (const sql of inScope) expect(balanceScopeViolation(sql), sql).toBeNull()
  })

  it('does not trip on words that merely contain an alias word', () => {
    for (const alias of ['rebalanced_total', 'networking_spend', 'unbalanced']) {
      expect(balanceScopeViolation(`SELECT SUM(amount) AS ${alias} FROM "Transaction"`), alias)
        .toBeNull()
    }
  })

  it('does not trip on CAST(... AS REAL) or a table alias', () => {
    const sql =
      `SELECT CAST(SUM(t.amount) AS REAL) / 100.0 AS total FROM "Transaction" AS t ` +
      `JOIN Account AS a ON t.accountId = a.id LIMIT 200`
    expect(balanceScopeViolation(sql)).toBeNull()
  })

  it('accepts the known gap: a balance aliased plain `total` passes (ADR-0010 § Consequences)', () => {
    // Documented, deliberate. The guard fires on the model's labelling, and
    // this is the case it cannot see. Recorded as a test so it is a decision on
    // the record rather than an oversight — closing it means building the
    // computeBalance-backed path, not more clever detection.
    const sql = `SELECT Account.name, SUM("Transaction".amount) / 100.0 AS total FROM "Transaction" ` +
      `JOIN Account ON "Transaction".accountId = Account.id GROUP BY Account.name`
    expect(balanceScopeViolation(sql)).toBeNull()
  })
})

describe('balanceScopeViolation — session 10 regression fixture (ADR-0010)', () => {
  it('(e) declines the liability-account SUM(amount) aliased as a balance', () => {
    const v = balanceScopeViolation(SESSION_10_SQL)
    expect(v).toMatchObject({ kind: 'balance-alias', alias: 'total_balance', word: 'balance' })
  })

  it('the same query aliased as net flow is in scope — only the claim was wrong', () => {
    expect(balanceScopeViolation(SESSION_10_SQL.replace('total_balance', 'net_flow'))).toBeNull()
  })
})

describe('extractAliases', () => {
  it('picks up every quoting style and skips CAST types only by vocabulary', () => {
    const sql = `SELECT a AS one, b AS "two", c AS [three], d AS \`four\` FROM t`
    expect(extractAliases(sql)).toEqual(['one', 'two', 'three', 'four'])
  })
})

describe('balanceScopeMessage', () => {
  it('explains the scope, not just the rejection', () => {
    const msg = balanceScopeMessage({ kind: 'balance-alias', alias: 'total_balance', word: 'balance' })
    expect(msg).toContain('total_balance')
    expect(msg).toMatch(/net flow/i)
    expect(msg).toMatch(/out of scope/i)
    expect(msg).toMatch(/dashboard/i)
  })

  it('names openingBalance for the column case', () => {
    expect(balanceScopeMessage({ kind: 'opening-balance' })).toMatch(/openingBalance/)
  })
})

describe('SQL_SYSTEM_PROMPT states the rule (prevention half)', () => {
  const prompt = buildSqlSystemPrompt(new Date('2026-07-29T00:00:00Z'), ['🛒 Groceries'])

  it('tells the model SUM(amount) is net flow and never a balance', () => {
    expect(prompt).toMatch(/NET FLOW/)
    expect(prompt).toMatch(/never that account's balance/i)
  })

  it('bans selecting or aggregating openingBalance', () => {
    expect(prompt).toMatch(/Account\.openingBalance must NOT be selected, aggregated/)
  })

  it('bans the balance alias vocabulary by name', () => {
    for (const word of BALANCE_ALIAS_WORDS) expect(prompt).toContain(`'${word}'`)
  })

  it('none of its own worked examples violate the guard it describes', () => {
    // A few-shot example that trips the guard would be the bug wearing the
    // fix's clothes (same failure ADR-0008 hit with its 'Groceries' literals).
    const examples = prompt.split('\n').filter((l) => l.startsWith('A: '))
    expect(examples.length).toBeGreaterThan(0)
    for (const line of examples) {
      expect(balanceScopeViolation(line.slice(3)), line).toBeNull()
    }
  })
})
