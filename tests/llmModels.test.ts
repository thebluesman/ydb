import { describe, expect, it } from 'vitest'
import { annotateModel, ROLE_META, LLM_DEFAULTS, type LlmRole } from '@/lib/llm-models'

// Metadata that the Settings model picker and the README both depend on. Keeping
// these in sync is easy to get wrong silently, so pin the contract.

const ROLES: LlmRole[] = ['extraction', 'sql', 'narration']

describe('LLM model metadata', () => {
  it('role defaults match the shipped LLM_DEFAULTS', () => {
    expect(ROLE_META.extraction.default).toBe(LLM_DEFAULTS.extractionModel)
    expect(ROLE_META.sql.default).toBe(LLM_DEFAULTS.sqlModel)
    expect(ROLE_META.narration.default).toBe(LLM_DEFAULTS.narrationModel)
    expect(ROLE_META.extraction.settingKey).toBe('extractionModel')
    expect(ROLE_META.sql.settingKey).toBe('sqlModel')
    expect(ROLE_META.narration.settingKey).toBe('narrationModel')
  })

  // The split is only useful if the two chat roles are separately addressable:
  // one setting key each, so configuring one cannot move the other.
  it('gives the two halves of a chat turn distinct setting keys', () => {
    expect(ROLE_META.sql.settingKey).not.toBe(ROLE_META.narration.settingKey)
    const keys = ROLES.map((r) => ROLE_META[r].settingKey)
    expect(new Set(keys).size).toBe(ROLES.length)
  })

  // Shipping both chat roles on the same model is what makes this change a
  // no-op for an un-configured install, and it is also what keeps the default
  // pair immune to the mid-turn VRAM eviction the split introduces. If someone
  // changes one default without the other, that property should be a deliberate
  // decision rather than a silent side effect.
  it('ships both chat roles on the same model by default', () => {
    expect(LLM_DEFAULTS.narrationModel).toBe(LLM_DEFAULTS.sqlModel)
  })

  // The co-residency guidance is guidance, not a code guard (this app cannot see
  // the box's VRAM), so the only place it can live is the narration
  // recommendation the operator reads while choosing.
  it('warns about model sizing where the pair is chosen', () => {
    expect(ROLE_META.narration.recommendation).toMatch(/VRAM|co-reside/i)
  })

  it('annotates the recommended models per role', () => {
    // The extraction default is called out as recommended for extraction.
    expect(annotateModel('qwen2.5-coder:14b', 'extraction')).toMatch(/recommended/i)
    // The SQL default is called out as recommended for SQL.
    expect(annotateModel('qwen2.5:32b', 'sql')).toMatch(/recommended/i)
    expect(annotateModel('qwen2.5:32b', 'narration')).toMatch(/recommended/i)
  })

  it('annotates known model families in every role', () => {
    for (const role of ROLES) {
      expect(annotateModel('mistral-small3.1:latest', role)).toBeTruthy()
      expect(annotateModel('qwen3.6:latest', role)).toBeTruthy()
    }
  })

  it('returns undefined for unknown models (selectable but unannotated)', () => {
    expect(annotateModel('some-random-model:7b', 'extraction')).toBeUndefined()
    expect(annotateModel('llama-obscure:1b', 'sql')).toBeUndefined()
    expect(annotateModel('llama-obscure:1b', 'narration')).toBeUndefined()
  })
})
