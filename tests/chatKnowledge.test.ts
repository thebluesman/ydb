import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildKnowledgeBlock,
  buildNarrationSystemPrompt,
  CONFIDENCE_RULE,
  RECAP_RULE,
  KNOWLEDGE_DIR,
  KNOWLEDGE_PRECEDENCE_LINE,
  loadKnowledgeSnippets,
} from '@/lib/chatKnowledge'

// The 12 active P0 snippets as of chat-knowledge ticket 3, in the order the
// loader must produce: id ascending, X1 (scope and refusal) forced last.
const EXPECTED_P0_ORDER = ['A1', 'A2', 'A3', 'A4', 'C1', 'C2', 'C3', 'D1', 'D2', 'D3', 'E1', 'X1']

describe('loadKnowledgeSnippets — real docs/knowledge/', () => {
  it('returns exactly the active P0 set, in deterministic order with X1 last', () => {
    const snippets = loadKnowledgeSnippets('P0')
    expect(snippets.map((s) => s.id)).toEqual(EXPECTED_P0_ORDER)
    expect(snippets.at(-1)?.id).toBe('X1')
  })

  it('only returns active snippets', () => {
    for (const s of loadKnowledgeSnippets('P0')) expect(s.status).toBe('active')
  })

  it('never injects human-only notes (anything from the first ## heading on)', () => {
    for (const s of loadKnowledgeSnippets('P0')) {
      expect(s.body).not.toContain('## Notes')
      expect(s.body).not.toContain('not injected')
    }
    // X1 is the snippet with the longest notes section — check it specifically.
    const x1 = loadKnowledgeSnippets('P0').find((s) => s.id === 'X1')!
    expect(x1.body).toContain('Decline investment')
    expect(x1.body).not.toContain('ticket-1 outline')
  })

  it('injects no digits at all, so no currency-formatted figure — in any form — can reach the prompt', () => {
    // Broader than a currency-symbol pattern on purpose: catches "500 AED",
    // "1,200 dirhams", and bare numbers too, not just "AED 500". The
    // cents-vs-dollars bug this guards against is about the open
    // [chat-bug] ticket staying attributable to one change, so the P0 set is
    // required to spell numbers out in prose rather than use digits.
    for (const s of loadKnowledgeSnippets('P0')) {
      expect(s.body).not.toMatch(/\d/)
    }
  })

  it('the priority tier is a parameter — a different tier changes the set', () => {
    const p0 = loadKnowledgeSnippets('P0').map((s) => s.id)
    const p1 = loadKnowledgeSnippets('P1').map((s) => s.id)
    expect(p1).not.toEqual(p0)
    // The 10 P1 snippets are status: active — it is the tier parameter, not
    // their status, that keeps them out of the prompt today. Lifting them is a
    // one-line change to NARRATION_KNOWLEDGE_TIER, exactly as ADR-0007 asks.
    expect(p1).toEqual(['A5', 'B1', 'B2', 'B3', 'C4', 'C5', 'C6', 'E2', 'E3', 'F1', 'X1'])
    // P2 (D4/F2/F3) are all status: held, so the tier yields only X1.
    expect(loadKnowledgeSnippets('P2').map((s) => s.id)).toEqual(['X1'])
  })

  it('skips README.md', () => {
    expect(loadKnowledgeSnippets('P0').map((s) => s.file)).not.toContain('README.md')
  })

  it('respects the documented word budget (80 hard cap per snippet)', () => {
    for (const s of loadKnowledgeSnippets('P0')) {
      expect(s.body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(80)
    }
  })
})

describe('loadKnowledgeSnippets — degradation', () => {
  it('missing directory is a no-op, not a throw', () => {
    expect(loadKnowledgeSnippets('P0', path.join(KNOWLEDGE_DIR, '__does_not_exist__'))).toEqual([])
  })

  it('empty directory is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-knowledge-empty-'))
    try {
      expect(loadKnowledgeSnippets('P0', dir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a malformed file is skipped without taking the good ones down', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-knowledge-mixed-'))
    try {
      fs.writeFileSync(path.join(dir, 'bad.md'), 'no front matter at all\n')
      fs.writeFileSync(
        path.join(dir, 'a1-ok.md'),
        '---\nid: A1\ntitle: "Fine"\npriority: P0\nstatus: active\n---\n\nGood body.\n\n## Notes\n\nHidden.\n',
      )
      const snippets = loadKnowledgeSnippets('P0', dir)
      expect(snippets.map((s) => s.id)).toEqual(['A1'])
      expect(snippets[0].body).toBe('Good body.')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('orders by id, not by filename or discovery order, and forces X1 last regardless of filename', () => {
    // Filenames deliberately sort in a different order than the ids they
    // declare, and includes a C9/C10 pair — a plain lexicographic id sort
    // would put "C10" before "C9". This fixture fails if compareIds's
    // letter/number parse (or the X1-forced-last rule) is disabled, unlike
    // EXPECTED_P0_ORDER above, whose real filenames happen to already sort
    // correctly under a plain alphabetical sort and so pass even with
    // ordering logic gutted.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-knowledge-order-'))
    try {
      const write = (file: string, id: string, priority: string) =>
        fs.writeFileSync(
          path.join(dir, file),
          `---\nid: ${id}\ntitle: "${id}"\npriority: ${priority}\nstatus: active\n---\n\nBody ${id}.\n`,
        )
      write('a-second-file.md', 'C9', 'P0')
      write('b-fourth-file.md', 'A2', 'P0')
      write('m-third-file.md', 'X1', 'P2') // wrong tier on purpose — exempt via ALWAYS_INJECT_IDS
      write('z-first-file.md', 'C10', 'P0')

      expect(loadKnowledgeSnippets('P0', dir).map((s) => s.id)).toEqual(['A2', 'C9', 'C10', 'X1'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a held snippet at the requested tier is excluded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-knowledge-held-'))
    try {
      fs.writeFileSync(
        path.join(dir, 'f2-held.md'),
        '---\nid: F2\ntitle: "Held"\npriority: P0\nstatus: held\n---\n\nShould not appear.\n',
      )
      expect(loadKnowledgeSnippets('P0', dir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildNarrationSystemPrompt', () => {
  // ADR-0020: units are now decided server-side before rows reach this prompt,
  // so the old "may already be dollars ... infer from context" hedge is gone —
  // this is no longer byte-for-byte the pre-ADR-0020 prompt, deliberately.
  //
  // The two trailing sentences are the standing rules with a per-turn switch
  // decided server-side: [chat-model] output 5's confidence rule, then output
  // 13's recap rule (lib/chatHedge.ts and lib/chatRecap.ts respectively).
  const NO_KNOWLEDGE_PROMPT =
    `You are a helpful financial assistant. Answer the user's question in plain English using the data provided. Be concise and specific -- include actual numbers from the data. All monetary values in the data are already in AED currency units, never raw cents — present them directly without any other currency symbols or conversions. ${CONFIDENCE_RULE} ${RECAP_RULE}`

  it('with no knowledge block, states units are already normalized (ADR-0020), with no inference clause', () => {
    expect(buildNarrationSystemPrompt('AED', '')).toBe(NO_KNOWLEDGE_PROMPT)
    expect(buildNarrationSystemPrompt('AED', '')).not.toMatch(/infer from context/i)
  })

  it('assembles persona → precedence line → knowledge → operative rules', () => {
    const prompt = buildNarrationSystemPrompt('AED', 'KNOWLEDGE-BODY')
    const persona = prompt.indexOf('You are a helpful financial assistant.')
    const precedence = prompt.indexOf(KNOWLEDGE_PRECEDENCE_LINE)
    const knowledge = prompt.indexOf('KNOWLEDGE-BODY')
    const rules = prompt.indexOf("Answer the user's question in plain English")
    expect(persona).toBeGreaterThanOrEqual(0)
    expect(precedence).toBeGreaterThan(persona)
    expect(knowledge).toBeGreaterThan(precedence)
    expect(rules).toBeGreaterThan(knowledge)
  })

  it('keeps the operative rules last, so front-truncation loses knowledge before instructions', () => {
    const prompt = buildNarrationSystemPrompt('AED', 'KNOWLEDGE-BODY')
    expect(prompt).toContain('without any other currency symbols or conversions.')
    expect(prompt.endsWith(RECAP_RULE)).toBe(true)
  })

  // [chat-model] output 5. The rule has to carry BOTH branches: the no-caveat
  // branch is what stops "hedge when appropriate" turning into hedging on every
  // answer, which is the failure this feature was scoped against.
  it('states the no-caveat branch as flatly as the caveat branch', () => {
    expect(CONFIDENCE_RULE).toMatch(/if no caveat is stated/i)
    expect(CONFIDENCE_RULE).toMatch(/do not hedge/i)
  })

  // [chat-model] output 16. The voice setting moves the persona line and
  // nothing else — the operative rules, including the units rule and the
  // confidence rule, are identical under both styles.
  it('swaps only the persona line between voices', () => {
    const direct = buildNarrationSystemPrompt('AED', 'KNOWLEDGE-BODY', 'direct')
    const coaching = buildNarrationSystemPrompt('AED', 'KNOWLEDGE-BODY', 'coaching')
    expect(direct).toBe(buildNarrationSystemPrompt('AED', 'KNOWLEDGE-BODY'))
    expect(direct).not.toBe(coaching)
    expect(coaching).toContain('supportive financial coach')
    expect(coaching).not.toContain('You are a helpful financial assistant.')
    for (const prompt of [direct, coaching]) {
      expect(prompt).toContain('already in AED currency units')
      expect(prompt.endsWith(RECAP_RULE)).toBe(true)
    }
  })

  // The coaching voice must not become a licence to reshape a figure. A model
  // told only "be supportive" will round a bad month down; the persona carries
  // its own prohibition so the softening stays in the framing.
  it('forbids the coaching voice from altering any figure', () => {
    const coaching = buildNarrationSystemPrompt('AED', '', 'coaching')
    expect(coaching).toMatch(/never soften, round, omit or editorialise a figure/i)
  })

  it('honours the base currency', () => {
    expect(buildNarrationSystemPrompt('INR', 'K')).toContain('already in INR currency units')
  })

  it('carries every active P0 snippet body into the assembled prompt', () => {
    const snippets = loadKnowledgeSnippets('P0')
    const prompt = buildNarrationSystemPrompt('AED', buildKnowledgeBlock(snippets))
    for (const s of snippets) {
      const firstSentence = s.body.replace(/\n+/g, ' ').split('. ')[0]
      expect(prompt).toContain(firstSentence)
    }
  })
})

describe('buildKnowledgeBlock', () => {
  it('returns empty string for no snippets, so the caller falls through cleanly', () => {
    expect(buildKnowledgeBlock([])).toBe('')
  })

  it('emits bodies only — no ids, titles, or front-matter', () => {
    const block = buildKnowledgeBlock(loadKnowledgeSnippets('P0'))
    expect(block).not.toContain('priority:')
    expect(block).not.toContain('keywords:')
    expect(block).not.toContain('Scope and refusal') // X1's title
  })
})
