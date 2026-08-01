import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_VOCABULARY_CAP,
  AccountVocabularyTooLarge,
  NO_MATCH_SENTINEL,
  accountNameScope,
  buildAccountVocabularyBlock,
  closestAccounts,
  extractAccountPredicates,
  loadAccountVocabulary,
  unknownAccountLiterals,
  unknownAccountMessage,
} from '@/lib/chatAccountVocabulary'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'

// ─────────────────────────────────────────────────────────────────────────────
// Account-name grounding — ADR-0008's mechanism applied to Account.name.
//
// Mirrors tests/chatCategoryVocabulary.test.ts in structure, and diverges in
// exactly one place: `name` is not a distinctive column, so a whole section here
// is about resolving WHICH table a `name` predicate belongs to. That section has
// no counterpart on the category side and is where the real risk lives.
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNTS = ['ADCB Current', 'Emirates NBD Savings', 'Mashreq Neo Visa', "Sarah's ISA"]

const JUL_29_2026 = new Date('2026-07-29T10:00:00.000Z')

function source(names: (string | null)[]) {
  return { account: { findMany: async () => names.map((name) => ({ name })) } }
}

describe('loadAccountVocabulary', () => {
  it('returns the distinct stored names, sorted', async () => {
    expect(await loadAccountVocabulary(source(['Zebra', 'Apple', 'Apple']))).toEqual(['Apple', 'Zebra'])
  })

  it('drops blank and whitespace-only names', async () => {
    expect(await loadAccountVocabulary(source(['  ', '', null, ' Real ']))).toEqual(['Real'])
  })

  it('throws past the cap rather than truncating to a partial list', async () => {
    const many = Array.from({ length: ACCOUNT_VOCABULARY_CAP + 1 }, (_, i) => `Account ${i}`)
    await expect(loadAccountVocabulary(source(many))).rejects.toBeInstanceOf(AccountVocabularyTooLarge)
  })

  it('is fine exactly at the cap', async () => {
    const exactly = Array.from({ length: ACCOUNT_VOCABULARY_CAP }, (_, i) => `Account ${i}`)
    expect(await loadAccountVocabulary(source(exactly))).toHaveLength(ACCOUNT_VOCABULARY_CAP)
  })
})

describe('accountNameScope — which identifiers mean Account here', () => {
  it('binds a JOIN alias', () => {
    const scope = accountNameScope('SELECT 1 FROM "Transaction" t JOIN Account a ON a.id = t.accountId')
    expect(scope.qualifiers).toContain('a')
    expect(scope.qualifiers).toContain('Account')
    expect(scope.bareNameIsAccount).toBe(false)
  })

  it('binds an AS alias', () => {
    expect(accountNameScope('SELECT 1 FROM Account AS acct').qualifiers).toContain('acct')
  })

  it('does not mistake a following keyword for an alias', () => {
    // `FROM Account WHERE ...` — without the keyword list this binds "WHERE".
    const scope = accountNameScope("SELECT id FROM Account WHERE name = 'x'")
    expect(scope.qualifiers).toEqual(['Account'])
    expect(scope.bareNameIsAccount).toBe(true)
  })

  it('a bare `name` is ambiguous the moment a second table is read', () => {
    const scope = accountNameScope(
      'SELECT name FROM Account WHERE id IN (SELECT accountId FROM "Transaction")',
    )
    expect(scope.bareNameIsAccount).toBe(false)
  })

  it('finds nothing when Account is not in the query at all', () => {
    const scope = accountNameScope('SELECT SUM(amount) AS total FROM "Transaction"')
    expect(scope.qualifiers).toEqual([])
    expect(scope.bareNameIsAccount).toBe(false)
  })
})

describe('extractAccountPredicates', () => {
  const q = (where: string) =>
    `SELECT 1 FROM "Transaction" t JOIN Account a ON a.id = t.accountId WHERE ${where}`

  it.each([
    ['equality', "a.name = 'ADCB Current'", { literal: 'ADCB Current', caseFolded: false, pattern: false }],
    ['reversed equality', "'ADCB Current' = a.name", { literal: 'ADCB Current', caseFolded: false, pattern: false }],
    ['inequality', "a.name != 'ADCB Current'", { literal: 'ADCB Current', caseFolded: false, pattern: false }],
    ['LIKE', "a.name LIKE '%NBD%'", { literal: '%NBD%', caseFolded: false, pattern: true }],
    ['case-folded', "lower(a.name) = 'adcb current'", { literal: 'adcb current', caseFolded: true, pattern: false }],
    ['quoted column', `a."name" = 'ADCB Current'`, { literal: 'ADCB Current', caseFolded: false, pattern: false }],
  ])('%s', (_label, where, expected) => {
    expect(extractAccountPredicates(q(where))).toContainEqual(expected)
  })

  it('unpacks an IN list', () => {
    const found = extractAccountPredicates(q("a.name IN ('ADCB Current', 'Mashreq Neo Visa')"))
    expect(found.map((p) => p.literal)).toEqual(['ADCB Current', 'Mashreq Neo Visa'])
  })

  it("undoes SQL's doubled-quote escaping", () => {
    expect(extractAccountPredicates(q("a.name = 'Sarah''s ISA'"))[0].literal).toBe("Sarah's ISA")
  })

  it('ignores a name predicate on a table that is not Account', () => {
    const sql = `SELECT 1 FROM "Transaction" t JOIN Category c ON c.name = t.category WHERE c.name = 'Travel'`
    expect(extractAccountPredicates(sql)).toEqual([])
  })

  it('ignores predicates on other Account columns', () => {
    expect(extractAccountPredicates(q("a.accountType = 'credit'"))).toEqual([])
  })
})

describe('unknownAccountLiterals', () => {
  it('accepts an exact stored name', () => {
    const sql = `SELECT 1 FROM Account a WHERE a.name = 'ADCB Current'`
    expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual([])
  })

  it('rejects a name that is not stored', () => {
    const sql = `SELECT 1 FROM Account a WHERE a.name = 'Barclays Everyday'`
    expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual(['Barclays Everyday'])
  })

  it("rejects session 10's generic account-type phrase", () => {
    // The fixture bug: '%credit card%' describes a KIND of account. No ledger
    // names an account that, so the query runs and matches nothing.
    const sql = `SELECT 1 FROM "Transaction" t JOIN Account a ON a.id = t.accountId WHERE a.name LIKE '%credit card%'`
    expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual(['%credit card%'])
  })

  it('accepts a LIKE fragment that occurs in a stored name', () => {
    const sql = `SELECT 1 FROM Account a WHERE a.name LIKE '%NBD%'`
    expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual([])
  })

  it("accepts `LIKE '%'`, which filters nothing", () => {
    expect(unknownAccountLiterals(`SELECT 1 FROM Account a WHERE a.name LIKE '%'`, ACCOUNTS)).toEqual([])
  })

  it('honours an explicit case fold, and only an explicit one', () => {
    const folded = `SELECT 1 FROM Account a WHERE lower(a.name) = 'adcb current'`
    const unfolded = `SELECT 1 FROM Account a WHERE a.name = 'adcb current'`
    expect(unknownAccountLiterals(folded, ACCOUNTS)).toEqual([])
    expect(unknownAccountLiterals(unfolded, ACCOUNTS)).toEqual(['adcb current'])
  })

  it('de-duplicates repeated guesses', () => {
    const sql =
      `SELECT 1 FROM Account a WHERE a.name = 'Barclays' OR a.name = 'Barclays'`
    expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual(['Barclays'])
  })

  it('checks nothing against an empty vocabulary', () => {
    const sql = `SELECT 1 FROM Account a WHERE a.name = 'Anything'`
    expect(unknownAccountLiterals(sql, [])).toEqual([])
  })

  it('rejects the sentinel, with no new detection logic', () => {
    const sql = `SELECT 1 FROM Account a WHERE a.name = '${NO_MATCH_SENTINEL}'`
    expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual([NO_MATCH_SENTINEL])
  })
})

describe('closestAccounts', () => {
  it('offers a near miss', () => {
    expect(closestAccounts('ADCB Currnt', ACCOUNTS)).toContain('ADCB Current')
  })

  it('offers nothing rather than an unrelated name', () => {
    expect(closestAccounts('Skydiving', ACCOUNTS)).toEqual([])
  })

  it('strips LIKE wildcards before scoring', () => {
    expect(closestAccounts('%Emirates NBD%', ACCOUNTS)).toContain('Emirates NBD Savings')
  })
})

describe('unknownAccountMessage', () => {
  it('names the guess, denies the empty result, and offers the real names', () => {
    const msg = unknownAccountMessage(['Barclays Everyday'], ACCOUNTS)
    expect(msg).toContain('"Barclays Everyday"')
    expect(msg).toMatch(/not the same as nothing having happened/i)
    expect(msg).toContain('ADCB Current')
    expect(msg).not.toMatch(/^error/i)
  })

  it('never quotes the internal sentinel back at the user', () => {
    const msg = unknownAccountMessage([NO_MATCH_SENTINEL], ACCOUNTS)
    expect(msg).not.toContain(NO_MATCH_SENTINEL)
    expect(msg).toMatch(/don't have an account matching what you asked about/i)
  })

  it('names the real guesses when the sentinel arrives alongside one', () => {
    const msg = unknownAccountMessage(['Barclays', NO_MATCH_SENTINEL], ACCOUNTS)
    expect(msg).toContain('"Barclays"')
    expect(msg).not.toContain(NO_MATCH_SENTINEL)
  })

  it('summarises rather than listing when there are many accounts', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Account ${i}`)
    expect(unknownAccountMessage(['Nope'], many)).toMatch(/You have 20 accounts in total/)
  })
})

describe('buildAccountVocabularyBlock', () => {
  it('renders nothing for an empty vocabulary', () => {
    expect(buildAccountVocabularyBlock([])).toBe('')
  })

  it('lists one name per line and escapes embedded quotes', () => {
    const block = buildAccountVocabularyBlock(ACCOUNTS)
    expect(block).toContain(`  'ADCB Current'`)
    expect(block).toContain(`  'Sarah''s ISA'`)
    expect(block).toMatch(/MUST be copied exactly/)
    expect(block).toContain(NO_MATCH_SENTINEL)
  })
})

describe('buildSqlSystemPrompt with an account vocabulary', () => {
  it('injects the names and the exact-copy rule', () => {
    const prompt = buildSqlSystemPrompt(JUL_29_2026, ['🛒 Groceries'], ACCOUNTS)
    expect(prompt).toContain(`'Emirates NBD Savings'`)
    expect(prompt).toContain('Account vocabulary.')
    // The category block is still there and still separate.
    expect(prompt).toContain('Category vocabulary.')
    expect(prompt).toContain(`'🛒 Groceries'`)
  })

  it('tells the model not to star-project Account (the GAP 1 prevention half)', () => {
    expect(buildSqlSystemPrompt(JUL_29_2026)).toMatch(/Never use SELECT \*/)
  })

  it('is byte-for-byte unchanged when there are no accounts', () => {
    expect(buildSqlSystemPrompt(JUL_29_2026, ['🛒 Groceries'], [])).toBe(
      buildSqlSystemPrompt(JUL_29_2026, ['🛒 Groceries']),
    )
  })
})
