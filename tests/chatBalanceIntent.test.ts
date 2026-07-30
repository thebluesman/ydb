import { describe, expect, it } from 'vitest'

import { balanceIntentMatch, balanceIntentMessage } from '@/lib/chatBalanceIntent'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0015: balance scope is enforced on the question. These are the unit-level
// cases; tests/chatBalanceScopeRoute.test.ts covers the route behaviour (and the
// load-bearing assertion that no SQL is generated at all).
// ─────────────────────────────────────────────────────────────────────────────

describe('balanceIntentMatch — stock questions are declined', () => {
  it.each([
    // Shyam's live session, verbatim (ADR-0015 § Context).
    ["What's the balance on my car loan?", 'balance'],
    ['What is my net worth?', 'net worth'],
    ['What do I owe on the car?', 'owe'],
    ['How much is owed on my credit card?', 'owed'],
    ['What am I still owing on the loan?', 'owing'],
    ['What is my outstanding balance?', 'balance'],
    ['Show me the outstanding amount on my card', 'outstanding'],
    ['How much debt do I have?', 'debt'],
    ['How much principal is left?', 'principal'],
    ['What is the payoff amount on my car loan?', 'payoff'],
    ['How much is left on my loan?', 'how much is left on'],
    ['How much do I have in my current account?', 'how much do i have in'],
  ])('declines %j on %s', (question, phrase) => {
    expect(balanceIntentMatch(question)?.phrase).toBe(phrase)
  })

  it('quotes the user\'s own wording back, case preserved', () => {
    const match = balanceIntentMatch('What is my Net Worth today?')
    expect(match).toEqual({ phrase: 'net worth', matched: 'Net Worth' })
  })

  it('matches plurals', () => {
    expect(balanceIntentMatch('what are the balances on my accounts')?.phrase).toBe('balance')
    expect(balanceIntentMatch('how much are my debts')?.phrase).toBe('debt')
  })
})

describe('balanceIntentMatch — flow questions pass through', () => {
  it('lets the pay-off trap through: "pay off" is a verb, not the noun "payoff"', () => {
    // ADR-0015 § Consequences names this case explicitly. It is a legitimate
    // flow question — how much was paid during a period — and must reach SQL.
    expect(balanceIntentMatch('how much did I pay off my car loan last month')).toBeNull()
    expect(balanceIntentMatch('How much have I paid off on the loan this year?')).toBeNull()
    expect(balanceIntentMatch('Which loan should I pay off first?')).toBeNull()
  })

  it.each([
    'How much did I spend on groceries last month?',
    'What was the net flow on my loan this month?',
    'What did I spend by category this year?',
    'How many transactions do I have?',
    // The residual gap ADR-0010's alias check is retained to cover: no stock
    // noun, but the model may still reach for balance arithmetic.
    'How much is on my car loan?',
  ])('passes %j to SQL generation', (question) => {
    expect(balanceIntentMatch(question)).toBeNull()
  })

  it('matches whole word tokens only, so ordinary words nearby do not trip it', () => {
    expect(balanceIntentMatch('how much did I spend rebalancing my portfolio')).toBeNull()
    expect(balanceIntentMatch('what did I spend on networking events')).toBeNull()
    expect(balanceIntentMatch('how much went to Principality Insurance')).toBeNull()
  })

  it('known gap: "networth" unspaced is not in the vocabulary', () => {
    // On the record deliberately, the way PR #30 recorded the plain-`total`
    // alias gap. ADR-0015's vocabulary is "net worth" as two words, and
    // widening it token by token is the heuristic-chasing the ADR warns
    // against. Such a question falls through to ADR-0010's second net, which
    // catches it if the model aliases the column `net_worth` or reads
    // `openingBalance`. Closing it properly means `get_balances` (ADR-0013 C).
    expect(balanceIntentMatch('whats my networth right now')).toBeNull()
  })

  it('needs the full phrase, not part of it', () => {
    // "how much do I have" without "in" is not in the vocabulary; if the model
    // then writes balance arithmetic, the alias check catches it.
    expect(balanceIntentMatch('How much do I have?')).toBeNull()
  })
})

describe('balanceIntentMessage', () => {
  it('names the wording, the flow/balance distinction, and where the figure lives', () => {
    const match = balanceIntentMatch("What's the balance on my car loan?")!
    const message = balanceIntentMessage(match)

    expect(message).toContain('"balance"')
    expect(message).toMatch(/net flow/i)
    expect(message).toMatch(/dashboard/i)
    // No SQL exists at this point, so the message must not talk about a query
    // that was written or a column that was labelled.
    expect(message).not.toMatch(/result column/i)
  })
})
