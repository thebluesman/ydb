import { describe, expect, it } from 'vitest'
import { annotateModel, ROLE_META, LLM_DEFAULTS } from '@/lib/llm-models'

// Metadata that the Settings model picker and the README both depend on. Keeping
// these in sync is easy to get wrong silently, so pin the contract.

describe('LLM model metadata', () => {
  it('role defaults match the shipped LLM_DEFAULTS', () => {
    expect(ROLE_META.extraction.default).toBe(LLM_DEFAULTS.extractionModel)
    expect(ROLE_META.chat.default).toBe(LLM_DEFAULTS.chatModel)
    expect(ROLE_META.extraction.settingKey).toBe('extractionModel')
    expect(ROLE_META.chat.settingKey).toBe('chatModel')
  })

  it('annotates the recommended models per role', () => {
    // The extraction default is called out as recommended for extraction.
    expect(annotateModel('qwen2.5-coder:14b', 'extraction')).toMatch(/recommended/i)
    // The chat default is called out as recommended for SQL.
    expect(annotateModel('qwen2.5:32b', 'chat')).toMatch(/recommended/i)
  })

  it('annotates known model families in both roles', () => {
    expect(annotateModel('mistral-small3.1:latest', 'extraction')).toBeTruthy()
    expect(annotateModel('mistral-small3.1:latest', 'chat')).toBeTruthy()
    expect(annotateModel('qwen3.6:latest', 'chat')).toBeTruthy()
  })

  it('returns undefined for unknown models (selectable but unannotated)', () => {
    expect(annotateModel('some-random-model:7b', 'extraction')).toBeUndefined()
    expect(annotateModel('llama-obscure:1b', 'chat')).toBeUndefined()
  })
})
