import { prisma } from '@/lib/prisma'
import { LLM_DEFAULTS } from '@/lib/llm-models'

export { LLM_DEFAULTS }

export const LLM_SETTING_KEYS = ['ollamaUrl', 'extractionModel', 'chatModel'] as const

export type LlmConfig = {
  ollamaUrl: string
  extractionModel: string
  chatModel: string
}

/**
 * Resolve the LLM configuration for a single request.
 *
 * Precedence: Setting (DB) → env var → shipped default. The Setting is read
 * fresh on every call — deliberately NOT memoised in a module-level cache — so
 * a change made in the Settings UI takes effect on the next request without a
 * server restart, and can never go stale.
 */
export async function getLlmConfig(): Promise<LlmConfig> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: LLM_SETTING_KEYS as unknown as string[] } },
  })
  const fromSetting = (key: string): string | undefined => {
    const trimmed = settings.find((s) => s.key === key)?.value?.trim()
    return trimmed ? trimmed : undefined
  }

  return {
    ollamaUrl: fromSetting('ollamaUrl') ?? process.env.OLLAMA_URL ?? LLM_DEFAULTS.ollamaUrl,
    extractionModel:
      fromSetting('extractionModel') ?? process.env.OLLAMA_MODEL ?? LLM_DEFAULTS.extractionModel,
    chatModel: fromSetting('chatModel') ?? process.env.CHAT_MODEL ?? LLM_DEFAULTS.chatModel,
  }
}
