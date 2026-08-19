import { describe, expect, it } from 'vitest'

import { planningIntentMatch, planningIntentMessage } from '@/lib/chatPlanningIntent'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0029: planning/forecast/goal questions are declined on the question,
// same mechanism as ADR-0015's balance check. These are the unit-level cases;
// tests/chatPlanningIntentRoute.test.ts covers the route behaviour (and the
// load-bearing assertion that no SQL is generated at all).
// ─────────────────────────────────────────────────────────────────────────────

describe('planningIntentMatch — plan/target/prediction questions are declined', () => {
  it.each([
    // ADR-0029 § Context, verbatim production cases.
    ['What should I budget for next month?', 'budget for'],
    ['Am I on track to hit my savings goal?', 'savings goal'],
    ['What is my savings goal?', 'savings goal'],
    ['Can I afford a new car?', 'afford'],
    ['Can I afford it?', 'afford'],
    ['What is my forecast for next quarter?', 'forecast'],
    ['Predict my spending next month', 'predict'],
    ['What are my projected savings?', 'projected'],
    ['How much should I save each month?', 'how much should i'],
    ['Will I have enough for rent next month?', 'will i have'],
  ])('declines %j on %s', (question, phrase) => {
    expect(planningIntentMatch(question)?.phrase).toBe(phrase)
  })

  it('matches plurals', () => {
    expect(planningIntentMatch('what are my goals')?.phrase).toBe('goal')
  })
})

describe('planningIntentMatch — historical questions pass through', () => {
  it('lets a past-tense question containing a planning word through', () => {
    // ADR-0029 § Decision names this boundary explicitly.
    expect(planningIntentMatch('How much did I spend on my savings transfers last month?')).toBeNull()
  })

  it.each([
    'How much did I spend on groceries last month?',
    'What did I spend by category this year?',
    'How many transactions do I have?',
    'Which loan should I pay off first?',
  ])('passes %j to SQL generation', (question) => {
    expect(planningIntentMatch(question)).toBeNull()
  })
})

describe('planningIntentMessage', () => {
  it('names the wording and what the ledger holds instead of implying the feature is coming', () => {
    const match = planningIntentMatch('Am I on track to hit my savings goal?')!
    const message = planningIntentMessage(match)

    expect(message).toContain('"savings goal"')
    expect(message).toMatch(/recorded transactions/i)
    expect(message).not.toMatch(/coming soon|not yet built|not yet supported/i)
  })
})
