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
  // The two halves of a chat turn, split out of the former single `chatModel`.
  // Both ship as the SAME model, deliberately: that is byte-for-byte the old
  // behaviour on an un-configured install, and one model serving both calls
  // cannot be evicted by the other mid-turn. Pointing them at two different
  // models is the opt-in the split exists to enable — see ROLE_META.narration
  // for the sizing rule that comes with it.
  sqlModel: 'qwen2.5:32b',
  narrationModel: 'qwen2.5:32b',
} as const

export type LlmRole = 'extraction' | 'sql' | 'narration'

// The three roles the app drives Ollama for. A raw list of installed model names
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
  sql: {
    label: 'SQL model',
    settingKey: 'sqlModel',
    default: LLM_DEFAULTS.sqlModel,
    recommendation:
      'Turns a chat question into one SQLite query. Runs at temperature 0, off-screen, and can afford to be slow — accuracy is all that matters. qwen2.5:32b is best if the box has the memory; qwen2.5-coder:14b is the lighter fallback.',
  },
  narration: {
    label: 'Narration model',
    settingKey: 'narrationModel',
    default: LLM_DEFAULTS.narrationModel,
    recommendation:
      'Writes the answer you actually watch stream in, from rows the query already returned — so speed is felt here and a smaller model is often the better trade. If you set this to something other than the SQL model, size the pair to co-reside in VRAM (roughly 14B + 7B, not 32B + 32B): both are loaded within a single turn, and a box that can only hold one will stall mid-answer swapping them.',
  },
}

// Short annotations for known-good models, shown next to installed models in the
// Advanced picker. Unknown models are still selectable, just unannotated.
const KNOWN_MODEL_NOTES: {
  match: (name: string) => boolean
  extraction?: string
  sql?: string
  narration?: string
}[] = [
  {
    match: (n) => n.startsWith('qwen2.5-coder'),
    extraction: 'recommended — reliable structured output',
    sql: 'good for SQL, faster and lighter',
    narration: 'code-tuned — writes stiffer prose than qwen2.5',
  },
  {
    match: (n) => /^qwen2\.5:/.test(n),
    extraction: 'works, but heavier than needed',
    sql: 'recommended for SQL — most accurate here',
    narration: 'recommended — reads most naturally here',
  },
  {
    match: (n) => n.startsWith('qwen3'),
    extraction: 'newer, not validated for extraction here',
    sql: 'newer, not validated for SQL here',
    narration: 'newer, not validated for narration here',
  },
  {
    match: (n) => n.startsWith('mistral'),
    extraction: 'faster, less accurate on structured output',
    sql: 'faster, less accurate on SQL',
    narration: 'faster — a reasonable trade for narration',
  },
]

/** Annotation for a model name in a given role, or undefined if unknown. */
export function annotateModel(name: string, role: LlmRole): string | undefined {
  return KNOWN_MODEL_NOTES.find((m) => m.match(name))?.[role]
}
