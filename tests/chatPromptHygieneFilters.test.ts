import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSqlSystemPrompt,
  MANDATORY_HYGIENE_FILTERS,
  MANDATORY_HYGIENE_PREDICATES,
} from '@/lib/chatSqlPrompt'
import { buildVerificationSystemPrompt } from '@/lib/chatVerification'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0028's sibling to tests/chatSqlPromptGuardMatrix.test.ts.
//
// The bug this exists to prevent is not a wrong predicate, it is two prompts
// disagreeing about the same list. `buildSqlSystemPrompt` MANDATES four
// predicates no user ever asks for; `buildVerificationSystemPrompt` used to be
// told that a filter the question never mentioned is a mismatch, with no
// exception — so the verifier condemned the generator's own required output,
// and that was the single largest source of false `mismatch` in the first
// production `ChatVerdict` sample (n=18, 2026-08-09).
//
// The fix is one exported constant read by both. This file is what keeps it
// one: it asserts both builders render every entry, and that the verifier
// module has not quietly grown its own hand-typed copy of the list — which is
// how the two would drift apart again while both still looking correct.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-31T09:00:00.000Z')
const CATEGORIES = ['🛒 Groceries', '✈️ Travel', '🚗 Auto loans', '🍽️ Dining']
const ACCOUNTS = ['ADCB Credit Card', 'ADCB, Current', 'Emirates NBD Savings']

describe('the mandatory hygiene filters are one shared constant (ADR-0028)', () => {
  it('is the closed set of four the SQL prompt mandates', () => {
    // Exact, not a lower bound. Widening the generator's mandate is a decision
    // that has to be taken here, in the one place the verifier also reads,
    // rather than added to the SQL prompt alone.
    expect(MANDATORY_HYGIENE_PREDICATES).toEqual([
      `transactionType != 'transfer'`,
      'parentTransactionId IS NULL',
      'reimbursementTxId IS NULL',
      `status IN ('committed','reconciled')`,
    ])
    expect(Object.values(MANDATORY_HYGIENE_FILTERS)).toEqual(MANDATORY_HYGIENE_PREDICATES)
  })

  const renderings = [
    { label: 'no stored vocabulary', prompt: buildSqlSystemPrompt(NOW) },
    { label: 'with stored vocabulary', prompt: buildSqlSystemPrompt(NOW, CATEGORIES) },
    {
      label: 'with stored category and account vocabulary',
      prompt: buildSqlSystemPrompt(NOW, CATEGORIES, ACCOUNTS),
    },
  ]

  for (const { label, prompt } of renderings) {
    it(`the SQL prompt states every one of them (${label})`, () => {
      // Asserted per rendering for the same reason the guard matrix is: the
      // prompt is interpolated at request time, so the three vocabulary
      // branches are three different strings.
      for (const predicate of MANDATORY_HYGIENE_PREDICATES) {
        expect(prompt, `SQL prompt no longer mandates ${predicate}`).toContain(predicate)
      }
    })
  }

  it('the verifier prompt exempts every one of them from the FILTER check', () => {
    const prompt = buildVerificationSystemPrompt('2026-07-31')
    for (const predicate of MANDATORY_HYGIENE_PREDICATES) {
      expect(prompt, `verifier prompt no longer exempts ${predicate}`).toContain(predicate)
    }
    // The exemption is stated as fact about the query being read, inside the
    // FILTER question rather than as a free-floating aside.
    expect(prompt).toMatch(/1\. FILTER[^\n]*present by construction/)
  })

  it('the verifier module carries no hand-typed copy of the list', () => {
    // The drift path this file exists to close: a future edit restates the four
    // predicates in the verifier's prose, the two lists diverge, and both files
    // still read as correct on their own. Source-level, because the rendered
    // prompt cannot tell a constant from a literal.
    const source = readFileSync(join(process.cwd(), 'lib/chatVerification.ts'), 'utf8')
    expect(source).toContain('MANDATORY_HYGIENE_PREDICATES')
    for (const predicate of MANDATORY_HYGIENE_PREDICATES) {
      expect(source, `${predicate} is hardcoded in lib/chatVerification.ts`).not.toContain(predicate)
    }
  })
})

describe('the verifier LABEL check judges contradiction, not descriptiveness (ADR-0031)', () => {
  const prompt = buildVerificationSystemPrompt('2026-07-31')

  it('asks whether a name claims something its expression does not compute', () => {
    expect(prompt).toMatch(/2\. LABEL[^\n]*does NOT compute/)
    expect(prompt).toMatch(/2\. LABEL[^\n]*contradiction test/)
  })

  it('states the generic-alias convention as the expected output', () => {
    expect(prompt).toMatch(/2\. LABEL[^\n]*never on its own a mismatch/)
  })

  it('replaces the anti-sign prohibition rather than adding to it', () => {
    // The 2026-08-18 eval showed the model rephrasing past "never flag a column
    // for being negative" by complaining the NAME failed to encode the sign
    // instead. The prohibition is gone; what stands in its place is ADR-0027's
    // fact, which has no adjacent phrasing to route into.
    expect(prompt).not.toMatch(/Never flag a column for being negative/i)
    expect(prompt).toContain("a column's name is not the sign channel")
  })
})
