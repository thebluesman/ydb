import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Resolution order in lib/llm-config.ts, with the pre-split `chatModel` key in
// play. The split ([chat-perf]) replaced one chat setting with two — sqlModel
// and narrationModel — and chose a read-time fallback over a data migration.
// These tests pin what that fallback actually promises, because the failure it
// prevents is silent: an install that was deliberately set to one model quietly
// running a different one, with no error to notice.
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
const { LLM_DEFAULTS } = await import('@/lib/llm-models')

beforeEach(() => {
  settingRows = []
  // Env vars are ambient in this process, so blank them all out for a clean
  // baseline; the tests that care set them explicitly. Blank reads as unset at
  // every tier — see the blank-env test below, which pins that.
  vi.stubEnv('OLLAMA_URL', '')
  vi.stubEnv('OLLAMA_MODEL', '')
  vi.stubEnv('CHAT_MODEL', '')
  vi.stubEnv('SQL_MODEL', '')
  vi.stubEnv('NARRATION_MODEL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getLlmConfig — the two chat roles', () => {
  it('falls back to the shipped defaults when nothing is configured', async () => {
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe(LLM_DEFAULTS.sqlModel)
    expect(cfg.narrationModel).toBe(LLM_DEFAULTS.narrationModel)
  })

  // The migration case. An install configured before the split has exactly this
  // row and neither new key; it must keep running the model it was set to, in
  // both halves of the turn — which is byte-for-byte its pre-split behaviour.
  it('seeds both roles from a pre-split chatModel setting', async () => {
    settingRows = [{ key: 'chatModel', value: 'qwen2.5-coder:14b' }]
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe('qwen2.5-coder:14b')
    expect(cfg.narrationModel).toBe('qwen2.5-coder:14b')
  })

  // …and the legacy key stops mattering per-role as soon as that role is saved,
  // which is how the fallback self-cleans without a migration ever running.
  it('lets a new key override the legacy one, one role at a time', async () => {
    settingRows = [
      { key: 'chatModel', value: 'qwen2.5:32b' },
      { key: 'narrationModel', value: 'qwen2.5:7b' },
    ]
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe('qwen2.5:32b') // still on the legacy value
    expect(cfg.narrationModel).toBe('qwen2.5:7b') // migrated
  })

  it('keeps the two roles independent', async () => {
    settingRows = [
      { key: 'sqlModel', value: 'qwen2.5-coder:7b' },
      { key: 'narrationModel', value: 'mistral-small3.1:latest' },
    ]
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe('qwen2.5-coder:7b')
    expect(cfg.narrationModel).toBe('mistral-small3.1:latest')
  })

  // Precedence is Setting → env → default, and the legacy fallback sits inside
  // its own tier rather than jumping one: a stale DB row must not be beaten by
  // an env var, or the documented order stops meaning anything.
  it('prefers a legacy Setting over a new env var', async () => {
    settingRows = [{ key: 'chatModel', value: 'from-db:32b' }]
    vi.stubEnv('SQL_MODEL', 'from-env:7b')
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe('from-db:32b')
  })

  it('honours the pre-split CHAT_MODEL env var for both roles', async () => {
    vi.stubEnv('CHAT_MODEL', 'legacy-env:14b')
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe('legacy-env:14b')
    expect(cfg.narrationModel).toBe('legacy-env:14b')
  })

  it('prefers a role-specific env var over the legacy one', async () => {
    vi.stubEnv('CHAT_MODEL', 'legacy-env:14b')
    vi.stubEnv('NARRATION_MODEL', 'narration-env:7b')
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe('legacy-env:14b')
    expect(cfg.narrationModel).toBe('narration-env:7b')
  })

  // Blank-string rows are how the Settings UI records "use the default"
  // (ModelSettings saves '' for the default option), so an empty legacy row must
  // not shadow the default it is standing in for.
  it('treats a blank legacy value as unset', async () => {
    settingRows = [{ key: 'chatModel', value: '   ' }]
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe(LLM_DEFAULTS.sqlModel)
  })

  // A `CHAT_MODEL=` line with nothing after it is a blank env var, not a model
  // named ''. The Setting tier has always trimmed to unset; the env tier now
  // agrees, rather than resolving to '' and failing later at the Ollama call.
  it('treats a blank env var as unset, at every tier', async () => {
    vi.stubEnv('CHAT_MODEL', '  ')
    vi.stubEnv('NARRATION_MODEL', '')
    vi.stubEnv('OLLAMA_URL', '')
    const cfg = await getLlmConfig()
    expect(cfg.sqlModel).toBe(LLM_DEFAULTS.sqlModel)
    expect(cfg.narrationModel).toBe(LLM_DEFAULTS.narrationModel)
    expect(cfg.ollamaUrl).toBe(LLM_DEFAULTS.ollamaUrl)
  })

  it('leaves the extraction role untouched by the chat split', async () => {
    settingRows = [{ key: 'chatModel', value: 'qwen2.5:32b' }]
    const cfg = await getLlmConfig()
    expect(cfg.extractionModel).toBe(LLM_DEFAULTS.extractionModel)
  })
})
