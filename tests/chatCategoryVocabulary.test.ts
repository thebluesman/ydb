import { describe, it, expect } from 'vitest'
import {
  CATEGORY_VOCABULARY_CAP,
  CategoryVocabularyTooLarge,
  buildCategoryVocabularyBlock,
  closestCategories,
  extractCategoryPredicates,
  loadCategoryVocabulary,
  unknownCategoryLiterals,
  unknownCategoryMessage,
} from '@/lib/chatCategoryVocabulary'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'

// The dev-DB shape that produced the live bug: emoji-prefixed names, so a
// model's bare 'Travel' guess can never match what is stored.
const VOCAB = ['✈️ Travel', '🛒 Groceries', '🏠 Rent', '☕ Coffee & Tea']

const JUL_29_2026 = new Date('2026-07-29T10:15:00.000Z')

function fakeDb(categories: (string | null)[]) {
  return {
    transaction: {
      findMany: async () => categories.map((category) => ({ category })),
    },
  }
}

describe('loadCategoryVocabulary', () => {
  it('reads distinct stored Transaction.category values, sorted', async () => {
    const got = await loadCategoryVocabulary(fakeDb(['🛒 Groceries', '✈️ Travel', '🛒 Groceries']))
    expect(got).toEqual(['✈️ Travel', '🛒 Groceries'].sort((a, b) => a.localeCompare(b)))
    expect(got).toHaveLength(2)
  })

  it('drops empty and null categories — uncategorised is not a category', async () => {
    const got = await loadCategoryVocabulary(fakeDb(['', '   ', null, '🏠 Rent']))
    expect(got).toEqual(['🏠 Rent'])
  })

  it('escalates past the cap rather than truncating to a partial list', async () => {
    const tooMany = Array.from({ length: CATEGORY_VOCABULARY_CAP + 1 }, (_, i) => `Cat ${i}`)
    await expect(loadCategoryVocabulary(fakeDb(tooMany))).rejects.toBeInstanceOf(
      CategoryVocabularyTooLarge,
    )
  })

  it('accepts exactly the cap', async () => {
    const atCap = Array.from({ length: CATEGORY_VOCABULARY_CAP }, (_, i) => `Cat ${i}`)
    await expect(loadCategoryVocabulary(fakeDb(atCap))).resolves.toHaveLength(
      CATEGORY_VOCABULARY_CAP,
    )
  })
})

describe('buildCategoryVocabularyBlock', () => {
  it('renders every stored value verbatim as a quoted literal', () => {
    const block = buildCategoryVocabularyBlock(VOCAB)
    for (const c of VOCAB) expect(block).toContain(`'${c}'`)
  })

  it('states the closed-list rule', () => {
    const block = buildCategoryVocabularyBlock(VOCAB)
    expect(block).toMatch(/ONLY values stored/)
    expect(block).toMatch(/MUST be copied exactly/)
  })

  it('escapes an apostrophe in a category name', () => {
    expect(buildCategoryVocabularyBlock(["Sam's Club"])).toContain("'Sam''s Club'")
  })

  it('renders nothing for an empty vocabulary', () => {
    expect(buildCategoryVocabularyBlock([])).toBe('')
  })
})

describe('extractCategoryPredicates', () => {
  const literals = (sql: string) => extractCategoryPredicates(sql).map((p) => p.literal)

  it('finds a plain equality literal', () => {
    expect(literals(`SELECT 1 FROM "Transaction" WHERE category = 'Travel'`)).toEqual(['Travel'])
  })

  it('finds a table-qualified and quoted column reference', () => {
    expect(literals(`... WHERE "Transaction".category = 'Travel'`)).toEqual(['Travel'])
    expect(literals(`... WHERE t."category" = 'Travel'`)).toEqual(['Travel'])
  })

  it('finds literals inside IN (...)', () => {
    expect(literals(`... WHERE category IN ('Travel', 'Rent')`)).toEqual(['Travel', 'Rent'])
  })

  it('finds a case-folded comparison and flags it', () => {
    const preds = extractCategoryPredicates(`... WHERE lower(category) = 'travel'`)
    expect(preds).toEqual([{ literal: 'travel', caseFolded: true, pattern: false }])
  })

  it('finds a LIKE pattern and flags it', () => {
    const preds = extractCategoryPredicates(`... WHERE category LIKE '%Travel%'`)
    expect(preds).toEqual([{ literal: '%Travel%', caseFolded: false, pattern: true }])
  })

  it('finds a reversed comparison', () => {
    expect(literals(`... WHERE 'Travel' = category`)).toEqual(['Travel'])
  })

  it('ignores literals compared against other columns', () => {
    expect(literals(`... WHERE description = 'Travel' AND status = 'committed'`)).toEqual([])
  })

  it('unescapes a doubled quote', () => {
    expect(literals(`... WHERE category = 'Sam''s Club'`)).toEqual(["Sam's Club"])
  })
})

describe('unknownCategoryLiterals', () => {
  it('passes a literal copied exactly from the vocabulary', () => {
    const sql = `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = '✈️ Travel'`
    expect(unknownCategoryLiterals(sql, VOCAB)).toEqual([])
  })

  it('catches the live bug: a bare guess for an emoji-prefixed stored name', () => {
    const sql = `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Travel'`
    expect(unknownCategoryLiterals(sql, VOCAB)).toEqual(['Travel'])
  })

  it('catches a case/pluralisation near-miss', () => {
    expect(unknownCategoryLiterals(`... WHERE category = 'groceries'`, VOCAB)).toEqual(['groceries'])
  })

  it('catches an unknown value inside IN (...) while accepting the known one', () => {
    const sql = `... WHERE category IN ('✈️ Travel', 'Holidays')`
    expect(unknownCategoryLiterals(sql, VOCAB)).toEqual(['Holidays'])
  })

  it('accepts a genuinely case-folded comparison', () => {
    expect(unknownCategoryLiterals(`... WHERE lower(category) = '🏠 rent'`, VOCAB)).toEqual([])
  })

  it('accepts a LIKE whose core occurs in a stored value, rejects one that does not', () => {
    expect(unknownCategoryLiterals(`... WHERE category LIKE '%Travel%'`, VOCAB)).toEqual([])
    expect(unknownCategoryLiterals(`... WHERE category LIKE '%Childcare%'`, VOCAB)).toEqual([
      '%Childcare%',
    ])
  })

  it('passes a query that filters on no category at all', () => {
    expect(unknownCategoryLiterals(`SELECT COUNT(*) FROM "Transaction"`, VOCAB)).toEqual([])
  })

  it('de-duplicates a repeated unknown literal', () => {
    const sql = `... WHERE category = 'Travel' OR category = 'Travel'`
    expect(unknownCategoryLiterals(sql, VOCAB)).toEqual(['Travel'])
  })

  it('checks nothing when there is no vocabulary to be grounded in', () => {
    expect(unknownCategoryLiterals(`... WHERE category = 'Travel'`, [])).toEqual([])
  })
})

describe('closestCategories', () => {
  it('offers the stored name behind a bare guess', () => {
    expect(closestCategories('Travel', VOCAB)).toContain('✈️ Travel')
    expect(closestCategories('groceries', VOCAB)).toContain('🛒 Groceries')
  })

  it('offers nothing rather than an unrelated name', () => {
    expect(closestCategories('Childcare', VOCAB)).toEqual([])
  })
})

describe('unknownCategoryMessage', () => {
  const message = unknownCategoryMessage(['Travel'], VOCAB)

  it('says it has no matching category and names it', () => {
    expect(message).toContain("I don't have a category matching \"Travel\"")
  })

  it('is explicit that this is not a total of zero', () => {
    expect(message).toMatch(/not the same as spending nothing/)
  })

  it('offers the closest stored name', () => {
    expect(message).toContain('✈️ Travel')
  })

  it('lists the full vocabulary when it is short enough to be useful', () => {
    expect(message).toContain('🏠 Rent')
  })

  it('gives a count instead of a wall of names for a long vocabulary', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Category ${i}`)
    const msg = unknownCategoryMessage(['Nonsense'], many)
    expect(msg).toContain('40 categories in total')
    expect(msg).not.toContain('Category 39')
  })
})

// ADR-0008 § "Both passes must carry the list": the repair round-trip re-sends
// the same prompt string, so what matters is that the vocabulary is part of the
// prompt builder rather than something the route bolts on for the first call.
describe('buildSqlSystemPrompt with a category vocabulary', () => {
  const prompt = buildSqlSystemPrompt(JUL_29_2026, VOCAB)

  it('carries the closed list', () => {
    for (const c of VOCAB) expect(prompt).toContain(`'${c}'`)
    expect(prompt).toMatch(/MUST be copied exactly/)
  })

  it('draws its worked category examples from the vocabulary, not from a guess', () => {
    // The old examples filtered on bare 'Groceries'/'Travel' — a few-shot
    // demonstration of exactly the bug.
    expect(prompt).toContain(`category = '🛒 Groceries'`)
    expect(prompt).toContain(`category = '✈️ Travel'`)
    expect(prompt).not.toContain(`category = 'Groceries'`)
    expect(prompt).not.toContain(`category = 'Travel'`)
  })

  it('leaves every example query grounded in the vocabulary', () => {
    expect(unknownCategoryLiterals(prompt, VOCAB)).toEqual([])
  })

  it('keeps the date grounding from the previous ticket', () => {
    expect(prompt).toContain("Today's date is 2026-07-29")
    expect(prompt).toContain("strftime('%Y-%m', date) = '2026-06'")
  })

  it('falls back to an ungrounded prompt when nothing is categorised', () => {
    const bare = buildSqlSystemPrompt(JUL_29_2026, [])
    expect(bare).not.toMatch(/Category vocabulary/)
    expect(bare).toBe(buildSqlSystemPrompt(JUL_29_2026))
  })

  it('uses a stored value even when nothing resembles the example word', () => {
    const odd = ['🐈 Pet supplies', '🎸 Music']
    const p = buildSqlSystemPrompt(JUL_29_2026, odd)
    expect(unknownCategoryLiterals(p, odd)).toEqual([])
  })

  it('handles a single-category ledger without emitting an unlisted literal', () => {
    const one = ['🛒 Groceries']
    const p = buildSqlSystemPrompt(JUL_29_2026, one)
    expect(unknownCategoryLiterals(p, one)).toEqual([])
  })
})
