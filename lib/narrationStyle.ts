// The narration voice ([chat-model] output 16). Client-safe: no prisma, no
// node:fs, so the Settings picker and the narration prompt builder can both
// import the same source of truth rather than restating each other's strings.
//
// Two fixed options, not a freeform style field. This app has exactly one
// operator (AGENTS.md: LAN-only, single-user), so a closed set covers the need
// — and an open-ended "describe your preferred tone" box would be untested
// prompt-injection surface written straight into the system prompt for a
// feature with one user. Adding a third option is a one-entry change here;
// accepting arbitrary text is not on the table.

export const NARRATION_STYLES = ['direct', 'coaching'] as const

export type NarrationStyle = (typeof NARRATION_STYLES)[number]

/** Setting key and env var, alongside the model keys in lib/llm-config.ts. */
export const NARRATION_STYLE_SETTING_KEY = 'narrationStyle'

/**
 * The shipped default. `direct` carries the pre-existing persona line
 * byte-for-byte, so an install that never touches this setting gets exactly the
 * prompt it got before the setting existed.
 */
export const DEFAULT_NARRATION_STYLE: NarrationStyle = 'direct'

/**
 * The persona sentence each style contributes — the FIRST line of the narration
 * system prompt (see buildNarrationSystemPrompt for why order is load-bearing).
 *
 * Both personas are about phrasing only. Neither may license the model to add,
 * withhold, soften or round a figure: `coaching` changes the framing around the
 * number, never the number. That constraint is restated inside the coaching
 * text itself rather than left implicit, because "be encouraging" is exactly
 * the instruction a model obeys by fudging a bad month.
 */
export const NARRATION_STYLE_PERSONA: Record<NarrationStyle, string> = {
  direct: 'You are a helpful financial assistant.',
  coaching:
    'You are a supportive financial coach. Lead with the number, then add one short, ' +
    'practical, non-judgemental observation about it. Never soften, round, omit or ' +
    'editorialise a figure to make it sound better — the numbers are reported exactly ' +
    'as they are, and only the framing around them is warmer.',
}

/** Settings-UI copy. Lives here so the picker and the prompt cannot drift. */
export const NARRATION_STYLE_META: Record<
  NarrationStyle,
  { label: string; description: string }
> = {
  direct: {
    label: 'Direct',
    description: 'Blunt and short: the figure, the scope, nothing else.',
  },
  coaching: {
    label: 'Coaching',
    description: 'Same figures, softer framing — one practical observation alongside the number.',
  },
}

export function isNarrationStyle(value: unknown): value is NarrationStyle {
  return typeof value === 'string' && (NARRATION_STYLES as readonly string[]).includes(value)
}

/**
 * Resolve a stored/env value to a style, falling back to the default.
 *
 * Deliberately lenient about case and surrounding whitespace, and deliberately
 * NOT lenient about anything else: an unrecognised value falls back rather than
 * being passed through, so a typo in the Setting table can never reach the
 * system prompt as free text.
 */
export function resolveNarrationStyle(value: unknown): NarrationStyle {
  if (typeof value !== 'string') return DEFAULT_NARRATION_STYLE
  const normalized = value.trim().toLowerCase()
  return isNarrationStyle(normalized) ? normalized : DEFAULT_NARRATION_STYLE
}
