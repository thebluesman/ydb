'use client'

import type { Suggestion } from '@/lib/chatSuggestions'

/**
 * ADR-0024's `suggestions` frame, rendered as clickable chips under the answer.
 *
 * Clicking one submits it as the next question through the ordinary input path
 * — the same code that runs when Shyam types it himself. That is the ADR's
 * point rather than a shortcut: a suggestion IS a pre-filled question, and it
 * gets no elevated trust for having been offered. It goes through the SQL
 * prompt, the vocabulary grounding and every guard exactly as typed text does.
 *
 * The text is route-composed from a closed template set and never contains
 * model output or row text, so rendering it as a React child (escaped, like
 * every other string here) is the whole of the display-side treatment needed.
 */
export function ChatSuggestions({
  questions,
  disabled,
  onPick,
}: {
  questions: Suggestion[]
  disabled: boolean
  onPick: (text: string) => void
}) {
  if (questions.length === 0) return null

  return (
    <div
      // Named for screen readers: three unlabelled buttons after an answer are
      // ambiguous about what pressing one would do.
      role="group"
      aria-label="Suggested follow-up questions"
      style={{
        marginTop: '10px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
      }}
    >
      {questions.map((q) => (
        <button
          key={q.template}
          type="button"
          disabled={disabled}
          onClick={() => onPick(q.text)}
          className="btn"
          style={{
            padding: '6px 12px',
            borderRadius: '14px',
            border: '1px solid var(--border-warm)',
            backgroundColor: 'var(--bg-card-alt)',
            color: 'var(--tx-secondary)',
            fontSize: '12.5px',
            lineHeight: 1.4,
            fontFamily: 'inherit',
            textAlign: 'left',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            transition: 'background-color 0.15s, color 0.15s',
          }}
        >
          {q.text}
        </button>
      ))}
    </div>
  )
}
