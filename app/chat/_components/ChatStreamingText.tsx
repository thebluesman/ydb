/**
 * Real-data adaptation of docs/reference/beautiful-ui/StreamingText.tsx's
 * word-reveal effect. The reference component fakes streaming with a timer
 * over static demo copy (plus citation chips, source list, and follow-up
 * buttons — all fabricated, none of which apply here: YDB has no web
 * sources, and ADR-0024 already owns real follow-ups via ChatSuggestions).
 * This keeps only the reveal itself, driven by `ChatPane`'s actual SSE
 * token stream.
 *
 * `text` grows by append-only concatenation as tokens arrive, so splitting
 * it into words on every render and keying each word by its index is
 * enough to get the reference's effect for free: words already mounted
 * keep the same key and never remount (no replay), while newly-appended
 * words mount fresh and animate in — no extra "which words are new" state
 * needed.
 */
export function ChatStreamingText({ text, streaming }: { text: string; streaming: boolean }) {
  if (!streaming) return <>{text || '​'}</>

  const parts = text.split(/(\s+)/)

  return (
    <>
      {parts.map((part, i) =>
        part.trim() === '' ? (
          part
        ) : (
          <span key={i} className="inline" style={{ animation: 'ydb-stream-in 420ms cubic-bezier(0.22,0.61,0.25,1) both' }}>
            {part}
          </span>
        ),
      )}
      <span
        aria-hidden
        className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-ink"
        style={{ animation: 'ydb-fade-in 150ms ease-out both' }}
      />
    </>
  )
}
