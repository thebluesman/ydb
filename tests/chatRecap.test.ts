import { describe, expect, it } from 'vitest'
import { isRecapQuestion, recapInstruction } from '@/lib/chatRecap'
import { RECAP_RULE, buildNarrationSystemPrompt } from '@/lib/chatKnowledge'

// ─────────────────────────────────────────────────────────────────────────────
// [chat-model] output 13, the narrative period summary.
//
// The trigger is route-computed for lib/chatHedge.ts's reason: a model told to
// "write a fuller summary when appropriate" writes one for everything, and a
// paragraph wrapped around a single figure is the padding this must not
// produce. So the boundary that matters is the negative one — an ordinary
// period question is NOT a recap.
// ─────────────────────────────────────────────────────────────────────────────

describe('isRecapQuestion — fires on a recap framing', () => {
  const RECAPS = [
    'Give me a monthly recap',
    'Summarize my spending this quarter',
    'Can you summarise last month for me?',
    'Give me an overview of June',
    'How did my month go?',
    'Walk me through my spending in June 2026',
    'Tell me about my year',
  ]

  it.each(RECAPS)('%s', (question) => {
    expect(isRecapQuestion(question)).toBe(true)
  })
})

describe('isRecapQuestion — a period question is not a recap', () => {
  const NOT_RECAPS = [
    'How much did I spend last month?',
    'What are my top 5 spending categories this year?',
    'How much did I spend on groceries in June?',
    'What is my total income this month?',
    'How many transactions do I have?',
    'How much did I move between my accounts this year?',
  ]

  it.each(NOT_RECAPS)('%s', (question) => {
    expect(isRecapQuestion(question)).toBe(false)
  })
})

describe('recapInstruction', () => {
  it('is empty on an ordinary question, so nothing is appended at all', () => {
    expect(recapInstruction('How much did I spend last month?')).toBe('')
  })

  it('names a bounded length rather than inviting more prose', () => {
    const instruction = recapInstruction('Give me a monthly recap')
    expect(instruction).toContain('three to five sentences')
  })

  it('binds the paragraph to the rows it was given', () => {
    const instruction = recapInstruction('Give me a monthly recap')
    expect(instruction).toMatch(/must come from the rows above/i)
    expect(instruction).toMatch(/do not estimate/i)
    // The constraint docs/architecture.md states outright: a recap is answered
    // from grouped rows, never from more of them. Nothing in the instruction
    // may ask for, imply, or reference a larger row set.
    expect(instruction).not.toMatch(/more rows|all transactions|every transaction/i)
  })
})

describe('the standing rule in the narration system prompt', () => {
  it('is present, so the model has a default for non-recap turns', () => {
    expect(buildNarrationSystemPrompt('AED', '')).toContain(RECAP_RULE)
  })

  it('states the default branch explicitly — one or two sentences', () => {
    expect(RECAP_RULE).toMatch(/one or two sentences/i)
  })

  it('is conditioned on the per-turn instruction, not on the model\'s own judgement', () => {
    // "If a recap instruction is stated with the data" — the model is told to
    // look for the route's signal, not to decide for itself what counts.
    expect(RECAP_RULE).toMatch(/if a recap instruction is stated/i)
  })
})
