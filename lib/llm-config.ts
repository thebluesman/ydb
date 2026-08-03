import { prisma } from '@/lib/prisma'
import { LLM_DEFAULTS } from '@/lib/llm-models'
import {
  DEFAULT_NARRATION_STYLE,
  NARRATION_STYLE_SETTING_KEY,
  resolveNarrationStyle,
  type NarrationStyle,
} from '@/lib/narrationStyle'

export { LLM_DEFAULTS }

export const LLM_SETTING_KEYS = [
  'ollamaUrl',
  'extractionModel',
  'sqlModel',
  'narrationModel',
  NARRATION_STYLE_SETTING_KEY,
] as const

/**
 * The pre-split key that drove both halves of a chat turn. No longer written by
 * the Settings UI, still read here: an install configured before the split has
 * this row in its Setting table and nothing else, and a hard cutover would
 * silently move that install back onto the shipped default — a different model
 * than the one it was deliberately set to, with no error to notice.
 *
 * Read-time fallback rather than a data migration, because it is reversible and
 * self-cleaning. Nothing is rewritten, so rolling this change back leaves the
 * old key still authoritative; and the first save of either new key in the
 * Settings UI takes precedence over it permanently. See the PR for the full
 * reasoning.
 */
export const LEGACY_CHAT_MODEL_KEY = 'chatModel'

export type LlmConfig = {
  ollamaUrl: string
  extractionModel: string
  /** Generates the SQL for a chat turn: temperature 0, non-streaming, unseen. */
  sqlModel: string
  /** Narrates the result rows: streaming, and what the user actually feels. */
  narrationModel: string
  /**
   * The narration voice ([chat-model] output 16). Resolved to a member of the
   * closed set here — never a raw string — so nothing outside
   * lib/narrationStyle.ts can put arbitrary text into the system prompt.
   */
  narrationStyle: NarrationStyle
}

/**
 * Resolve the LLM configuration for a single request.
 *
 * Precedence: Setting (DB) → env var → shipped default, with the pre-split
 * `chatModel` Setting / `CHAT_MODEL` env var consulted at its own tier before
 * dropping to the next one. The Setting is read fresh on every call —
 * deliberately NOT memoised in a module-level cache — so a change made in the
 * Settings UI takes effect on the next request without a server restart, and
 * can never go stale.
 */
export async function getLlmConfig(): Promise<LlmConfig> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: [...LLM_SETTING_KEYS, LEGACY_CHAT_MODEL_KEY] } },
  })
  const fromSetting = (key: string): string | undefined => {
    const trimmed = settings.find((s) => s.key === key)?.value?.trim()
    return trimmed ? trimmed : undefined
  }

  // Blank-but-present is "unset" at every tier, not just the Setting tier. A
  // `CHAT_MODEL=` line in an env file used to resolve to a model literally named
  // '' and fail at the Ollama call with nothing pointing back here; the Setting
  // tier has always trimmed to undefined, and the two tiers disagreeing is the
  // kind of thing you debug twice.
  const fromEnv = (name: string): string | undefined => {
    const trimmed = process.env[name]?.trim()
    return trimmed ? trimmed : undefined
  }

  const legacyChatModel = fromSetting(LEGACY_CHAT_MODEL_KEY)

  return {
    ollamaUrl: fromSetting('ollamaUrl') ?? fromEnv('OLLAMA_URL') ?? LLM_DEFAULTS.ollamaUrl,
    extractionModel:
      fromSetting('extractionModel') ?? fromEnv('OLLAMA_MODEL') ?? LLM_DEFAULTS.extractionModel,
    sqlModel:
      fromSetting('sqlModel') ?? legacyChatModel ?? fromEnv('SQL_MODEL') ?? fromEnv('CHAT_MODEL')
      ?? LLM_DEFAULTS.sqlModel,
    narrationModel:
      fromSetting('narrationModel') ?? legacyChatModel ?? fromEnv('NARRATION_MODEL')
      ?? fromEnv('CHAT_MODEL') ?? LLM_DEFAULTS.narrationModel,
    // Same Setting → env → shipped-default ladder as the models above, with the
    // extra step that every tier is validated rather than trusted: an
    // unrecognised value at any tier falls through to `direct` instead of
    // reaching the prompt. Unset and misspelt therefore behave identically,
    // which is the safe direction — the alternative is a typo in a Setting row
    // silently rewriting the system prompt's first line.
    narrationStyle: resolveNarrationStyle(
      fromSetting(NARRATION_STYLE_SETTING_KEY) ?? fromEnv('NARRATION_STYLE') ?? DEFAULT_NARRATION_STYLE,
    ),
  }
}
