// Client-safe LLM metadata: shipped defaults, per-role recommendations, and
// model annotations. Kept free of any server-only import (no prisma) so it can
// be used from client components like PreferencesForm. The request-time
// resolution (getLlmConfig, which reads the DB) lives in ./llm-config.

// Shipped defaults — the last fallback if neither a Setting nor an env var is
// present. Must stay equal to the historical hardcoded values so an
// un-configured install behaves exactly as before.
export const LLM_DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  extractionModel: 'qwen2.5-coder:14b',
  chatModel: 'qwen2.5:32b',
} as const

export type LlmRole = 'extraction' | 'chat'

// The two roles the app drives Ollama for. A raw list of installed model names
// tells a user nothing about which is good at extraction vs. text-to-SQL, so we
// surface a role-specific recommendation instead of a bare dropdown.
export const ROLE_META: Record<
  LlmRole,
  { label: string; settingKey: string; default: string; recommendation: string }
> = {
  extraction: {
    label: 'Extraction model',
    settingKey: 'extractionModel',
    default: LLM_DEFAULTS.extractionModel,
    recommendation:
      'Reads statement text into structured transactions. qwen2.5-coder:14b is recommended — it reliably honours structured-output constraints and fits modest VRAM.',
  },
  chat: {
    label: 'Chat / SQL model',
    settingKey: 'chatModel',
    default: LLM_DEFAULTS.chatModel,
    recommendation:
      'Powers Text-to-SQL chat. qwen2.5:32b is best if the box has the memory; fall back to qwen2.5-coder:14b otherwise.',
  },
}

// Short annotations for known-good models, shown next to installed models in the
// Advanced picker. Unknown models are still selectable, just unannotated.
const KNOWN_MODEL_NOTES: {
  match: (name: string) => boolean
  extraction?: string
  chat?: string
}[] = [
  {
    match: (n) => n.startsWith('qwen2.5-coder'),
    extraction: 'recommended — reliable structured output',
    chat: 'good for SQL, faster and lighter',
  },
  {
    match: (n) => /^qwen2\.5:/.test(n),
    extraction: 'works, but heavier than needed',
    chat: 'recommended for SQL — most accurate here',
  },
  {
    match: (n) => n.startsWith('qwen3'),
    extraction: 'newer, not validated for extraction here',
    chat: 'newer, not validated for SQL here',
  },
  {
    match: (n) => n.startsWith('mistral'),
    extraction: 'faster, less accurate on structured output',
    chat: 'faster, less accurate on SQL',
  },
]

/** Annotation for a model name in a given role, or undefined if unknown. */
export function annotateModel(name: string, role: LlmRole): string | undefined {
  return KNOWN_MODEL_NOTES.find((m) => m.match(name))?.[role]
}
