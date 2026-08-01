import { describe, expect, it } from 'vitest'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'
import {
  accountNameScope,
  extractAccountPredicates,
  unknownAccountLiterals,
} from '@/lib/chatAccountVocabulary'

// ─────────────────────────────────────────────────────────────────────────────
// The Account-join worked example is one ADR-0018's guard can actually see.
//
// The prompt now demonstrates a Transaction → Account join with a grounded
// Account.name filter, because prose alone gave the model no shape to imitate
// for the single construct `accountNameScope` reads (docs/architecture.md's
// residual entry on that fail-open surface; ADR-0008's few-shot premise).
//
// This file exists because the example's *shape* is load-bearing, and a wrong
// shape fails silently. `accountNameScope` deliberately fails open: a join it
// does not recognise is not checked, the query still runs, and a bogus account
// name still returns a confident empty aggregate. Canonicalizing such a shape in
// the prompt would teach the model the one construct the guard cannot see —
// exactly backwards. So the example's own SQL is fed through the real resolver
// here rather than eyeballed.
//
// Guard completeness for this example lives in the guard matrix
// (tests/chatSqlPromptGuardMatrix.test.ts), which now renders an account
// vocabulary so this example is covered there too. What is asserted here is
// only what the matrix cannot express: that the guard resolves this shape.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-31T09:00:00.000Z')
const CATEGORIES = ['🛒 Groceries', '✈️ Travel', '🚗 Auto loans', '🍽️ Dining']
const ACCOUNTS = ['ADCB Credit Card', 'ADCB, Current', 'Emirates NBD Savings']

/** The A: line of the worked example that joins Account. */
function accountJoinExample(prompt: string): string {
  const sqls = prompt
    .split('\n')
    .filter((l) => l.startsWith('A: '))
    .map((l) => l.slice(3))
  const joined = sqls.filter((s) => /\bJOIN\s+"?Account"?/i.test(s))
  // Fails loudly if the example is renamed or removed, rather than letting every
  // assertion below pass vacuously against an empty list.
  expect(joined, 'no Account-join worked example found in the prompt').toHaveLength(1)
  return joined[0]
}

describe('the Account-join worked example', () => {
  const prompt = buildSqlSystemPrompt(NOW, CATEGORIES, ACCOUNTS)
  const sql = accountJoinExample(prompt)

  it('is resolved by accountNameScope — the whole point of the ticket', () => {
    const scope = accountNameScope(sql)
    // Both the table name and the alias bound to it in the JOIN.
    expect(scope.qualifiers).toContain('Account')
    expect(scope.qualifiers).toContain('a')
    // A joined query, so a bare `name` is ambiguous and correctly not claimed.
    expect(scope.bareNameIsAccount).toBe(false)
  })

  it('writes its name filter where the guard can read it', () => {
    const preds = extractAccountPredicates(sql)
    expect(preds).toHaveLength(1)
    expect(preds[0].literal).toBe('ADCB Credit Card')
  })

  it('grounds that literal in the stored vocabulary it was built from', () => {
    expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual([])
  })

  it('catches a bogus account name substituted into its own shape', () => {
    // The failure this ticket is about: session 10's `LIKE '%credit card%'`
    // against a ledger whose cards are named after their banks. Same shape,
    // ungrounded literal — the guard must fire, not fail open.
    const bogus = sql.replace(`'ADCB Credit Card'`, `'Main Credit Card'`)
    expect(bogus).not.toBe(sql)
    expect(unknownAccountLiterals(bogus, ACCOUNTS)).toEqual(['Main Credit Card'])

    const described = sql.replace(`a.name = 'ADCB Credit Card'`, `a.name LIKE '%platinum card%'`)
    expect(described).not.toBe(sql)
    expect(unknownAccountLiterals(described, ACCOUNTS)).toEqual(['%platinum card%'])
  })

  it('never star-projects Account', () => {
    // A star projection returns openingBalance without naming it, and ADR-0017's
    // post-execution row-key check rejects the result set.
    expect(/SELECT\s+\*/i.test(sql)).toBe(false)
    expect(/\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*\*/.test(sql)).toBe(false)
    expect(/openingBalance/i.test(sql)).toBe(false)
  })

  it('renders a grounded literal for whatever vocabulary it is given', () => {
    // The similarity match only picks which stored value illustrates the
    // example; on a ledger with nothing resembling "credit card" it must still
    // fall back to a real stored name rather than inventing one.
    const other = ['Wio Business', 'Zand Personal']
    const fallback = accountJoinExample(buildSqlSystemPrompt(NOW, CATEGORIES, other))
    expect(unknownAccountLiterals(fallback, other)).toEqual([])
  })
})

describe('why the example is aliased (characterisation of accountNameScope)', () => {
  // Not a preference — the unaliased form is invisible to the resolver. Its
  // TABLE_SOURCE_RE consumes the JOIN keyword as the first table's optional
  // alias, so the Account source is never matched and no qualifier is bound.
  //
  // This pins the reason. If accountNameScope is ever fixed to resolve these
  // shapes, this block is what should be deleted — and the prompt's join rule
  // can relax with it. Until then, changing the example to any shape below would
  // silently disable the guard on the shape the prompt teaches, which is the
  // failure mode this whole ticket exists to avoid.
  //
  // The resolver defect itself is OUT OF SCOPE here and routed to its own
  // follow-up ticket. What follows is a complete before/after fixture for
  // whoever picks that up: every shape below is characterised as it behaves
  // TODAY, so a fix flips these assertions and the diff shows exactly what it
  // bought. Each was verified empirically against the real resolver, not
  // inferred from reading the regex.
  const BOGUS = 'Main Credit Card' // not in ACCOUNTS

  // ── Fail-open: the guard sees no Account source, so a bogus name is not caught.
  //
  // The common factor is that the FIRST table source carries no alias, so the
  // `JOIN` keyword lands in TABLE_SOURCE_RE's optional-alias group. `NOT_AN_ALIAS`
  // correctly declines to BIND it as an alias, but the regex has already consumed
  // it, so the `Account` source that follows is never matched. Quoting and line
  // breaks are incidental — they are enumerated because the model can emit any of
  // them, not because they are separate causes.
  const FAIL_OPEN: Record<string, string> = {
    'unaliased':
      `SELECT SUM(-"Transaction".amount) / 100.0 AS total_spent FROM "Transaction" ` +
      `JOIN Account ON "Transaction".accountId = Account.id WHERE Account.name = '${BOGUS}'`,
    'unaliased and unquoted':
      `SELECT SUM(-Transaction.amount) / 100.0 AS total_spent FROM Transaction ` +
      `JOIN Account ON Transaction.accountId = Account.id WHERE Account.name = '${BOGUS}'`,
    'unaliased across a line break':
      `SELECT SUM(-"Transaction".amount) / 100.0 AS total_spent FROM "Transaction"\n` +
      `JOIN Account ON "Transaction".accountId = Account.id\nWHERE Account.name = '${BOGUS}'`,
    'unaliased with a quoted "Account"':
      `SELECT SUM(-"Transaction".amount) / 100.0 AS total_spent FROM "Transaction" ` +
      `JOIN "Account" ON "Transaction".accountId = "Account".id WHERE "Account".name = '${BOGUS}'`,
    // The one that is aliased and still fails, by a different route: there is no
    // JOIN keyword at all, and TABLE_SOURCE_RE only anchors on FROM or JOIN, so
    // the second table in the comma list is never a table source. Aliasing alone
    // is therefore not the whole rule — the prompt teaches an explicit JOIN too.
    'comma join, even fully aliased':
      `SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t, Account a ` +
      `WHERE t.accountId = a.id AND a.name = '${BOGUS}'`,
  }

  for (const [shape, sql] of Object.entries(FAIL_OPEN)) {
    it(`fails open on a Transaction→Account join: ${shape}`, () => {
      expect(accountNameScope(sql).qualifiers).toEqual([])
      expect(extractAccountPredicates(sql)).toEqual([])
      expect(unknownAccountLiterals(sql, ACCOUNTS)).toEqual([])
    })
  }

  it('resolves the same join once the tables are aliased, line breaks and all', () => {
    // The control. Line breaks are NOT the cause — this is the line-broken shape
    // above with aliases added, and it resolves. Without this row the fixture
    // would read as though newlines were a separate defect.
    const ALIASED =
      `SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t\n` +
      `JOIN Account a ON t.accountId = a.id\nWHERE a.name = '${BOGUS}'`
    expect(accountNameScope(ALIASED).qualifiers).toEqual(['Account', 'a'])
    expect(unknownAccountLiterals(ALIASED, ACCOUNTS)).toEqual([BOGUS])
  })

  it('falsely claims a bare name when Account is joined to another table', () => {
    // The mirror defect, and the more damaging one: not a missed check but a
    // WRONG one. Same alias swallow, with Account first — `JOIN` is consumed as
    // Account's alias slot, so `Category` never enters `tables`, `tables.size`
    // is 1, and bareNameIsAccount comes back true for a query where a bare
    // `name` is genuinely ambiguous. Here it is Category.name, so a perfectly
    // valid category filter is reported as an unknown ACCOUNT literal and the
    // query is refused. Fail-open loses a check; this invents one.
    const FALSE_POSITIVE = `SELECT c.id FROM Account JOIN Category c ON 1=1 WHERE name = 'Groceries'`
    const scope = accountNameScope(FALSE_POSITIVE)
    expect(scope.bareNameIsAccount).toBe(true)
    expect(unknownAccountLiterals(FALSE_POSITIVE, ACCOUNTS)).toEqual(['Groceries'])
  })

  it('correctly claims a bare name when Account really is the only table', () => {
    // The behaviour bareNameIsAccount exists for, and the reason the case above
    // cannot simply be switched off: single-table Account queries must keep
    // resolving a bare `name`.
    const SOLE = `SELECT id FROM Account WHERE name = '${BOGUS}'`
    expect(accountNameScope(SOLE).bareNameIsAccount).toBe(true)
    expect(unknownAccountLiterals(SOLE, ACCOUNTS)).toEqual([BOGUS])
  })
})
