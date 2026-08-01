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
  // This pins the reason. If accountNameScope is ever fixed to resolve the
  // unaliased shape, this block is what should be deleted — and the prompt's
  // join rule can relax with it. Until then, changing the example to the
  // unaliased form would silently disable the guard on the shape the prompt
  // teaches, which is the failure mode this whole ticket exists to avoid.
  const UNALIASED =
    `SELECT SUM(-"Transaction".amount) / 100.0 AS total_spent FROM "Transaction" ` +
    `JOIN Account ON "Transaction".accountId = Account.id WHERE Account.name = 'Main Credit Card'`

  it('does not resolve a plain unaliased Transaction→Account join', () => {
    expect(accountNameScope(UNALIASED).qualifiers).toEqual([])
    expect(extractAccountPredicates(UNALIASED)).toEqual([])
    // Fails open: a bogus name in this shape is not caught.
    expect(unknownAccountLiterals(UNALIASED, ACCOUNTS)).toEqual([])
  })
})
