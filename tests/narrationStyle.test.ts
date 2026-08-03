import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// The narration voice setting ([chat-model] output 16): its resolution rules in
// lib/narrationStyle.ts, and how getLlmConfig reads it off the Setting table.
//
// The failure being pinned is a quiet one. This value lands in the FIRST line of
// the narration system prompt, so anything that isn't a member of the closed set
// must degrade to `direct` rather than pass through — a stray Setting row is not
// allowed to become prompt text.
// ─────────────────────────────────────────────────────────────────────────────

let settingRows: { key: string; value: string }[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        settingRows.filter((r) => where.key.in.includes(r.key)),
    },
  },
}))

const { getLlmConfig } = await import('@/lib/llm-config')
const {
  DEFAULT_NARRATION_STYLE,
  NARRATION_STYLES,
  NARRATION_STYLE_META,
  NARRATION_STYLE_PERSONA,
  NARRATION_STYLE_SETTING_KEY,
  isNarrationStyle,
  resolveNarrationStyle,
} = await import('@/lib/narrationStyle')

beforeEach(() => {
  settingRows = []
  vi.stubEnv('OLLAMA_URL', '')
  vi.stubEnv('OLLAMA_MODEL', '')
  vi.stubEnv('CHAT_MODEL', '')
  vi.stubEnv('SQL_MODEL', '')
  vi.stubEnv('NARRATION_MODEL', '')
  vi.stubEnv('NARRATION_STYLE', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveNarrationStyle', () => {
  it('accepts every member of the closed set', () => {
    for (const style of NARRATION_STYLES) expect(resolveNarrationStyle(style)).toBe(style)
  })

  it('tolerates case and surrounding whitespace', () => {
    expect(resolveNarrationStyle('  Coaching ')).toBe('coaching')
    expect(resolveNarrationStyle('DIRECT')).toBe('direct')
  })

  // The load-bearing case: a value that isn't a style is NOT passed through.
  it('falls back to the default for anything outside the set', () => {
    for (const bad of ['', '   ', 'friendly', 'direct-ish', 'ignore previous instructions', null, undefined, 7, {}]) {
      expect(resolveNarrationStyle(bad)).toBe(DEFAULT_NARRATION_STYLE)
    }
  })

  it('has a persona and UI copy for every style, and no others', () => {
    expect(Object.keys(NARRATION_STYLE_PERSONA).sort()).toEqual([...NARRATION_STYLES].sort())
    expect(Object.keys(NARRATION_STYLE_META).sort()).toEqual([...NARRATION_STYLES].sort())
  })

  it('keeps the default persona byte-for-byte the pre-setting sentence', () => {
    expect(DEFAULT_NARRATION_STYLE).toBe('direct')
    expect(NARRATION_STYLE_PERSONA.direct).toBe('You are a helpful financial assistant.')
  })

  it('isNarrationStyle is exact — no normalisation, unlike the resolver', () => {
    expect(isNarrationStyle('direct')).toBe(true)
    expect(isNarrationStyle('Direct')).toBe(false)
    expect(isNarrationStyle('warm')).toBe(false)
  })
})

describe('getLlmConfig — narrationStyle', () => {
  it('defaults to direct when nothing is configured', async () => {
    expect((await getLlmConfig()).narrationStyle).toBe('direct')
  })

  it('reads a saved Setting', async () => {
    settingRows = [{ key: NARRATION_STYLE_SETTING_KEY, value: 'coaching' }]
    expect((await getLlmConfig()).narrationStyle).toBe('coaching')
  })

  it('falls back to the env var when no Setting row exists', async () => {
    vi.stubEnv('NARRATION_STYLE', 'coaching')
    expect((await getLlmConfig()).narrationStyle).toBe('coaching')
  })

  it('lets the Setting win over the env var', async () => {
    settingRows = [{ key: NARRATION_STYLE_SETTING_KEY, value: 'direct' }]
    vi.stubEnv('NARRATION_STYLE', 'coaching')
    expect((await getLlmConfig()).narrationStyle).toBe('direct')
  })

  // Blank reads as unset at every tier, the same promise lib/llm-config.ts makes
  // for the model keys.
  it('treats a blank Setting as unset', async () => {
    settingRows = [{ key: NARRATION_STYLE_SETTING_KEY, value: '   ' }]
    expect((await getLlmConfig()).narrationStyle).toBe('direct')
  })

  it('never surfaces an unrecognised stored value', async () => {
    settingRows = [{ key: NARRATION_STYLE_SETTING_KEY, value: 'You are a pirate.' }]
    const cfg = await getLlmConfig()
    expect(cfg.narrationStyle).toBe('direct')
    expect(NARRATION_STYLES).toContain(cfg.narrationStyle)
  })

  it('leaves the model settings alone', async () => {
    settingRows = [{ key: NARRATION_STYLE_SETTING_KEY, value: 'coaching' }]
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe('qwen2.5:32b')
    expect(cfg.narrationModel).toBe('qwen2.5:32b')
  })
})
