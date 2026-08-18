'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Real-data adaptation of docs/reference/beautiful-ui/ThinkingState.tsx's
 * "Steps" variant. The reference component drives a fake, self-timed
 * sequence over demo copy; this one is driven by the actual chat stream's
 * stage transitions (`ChatPane` sets `stage` as the `sql`/`result`/first
 * `token` events land — see ADR-0025's verification pass, which is the real
 * work happening during this window).
 *
 * The working-state icon and live elapsed counter are folded in from
 * docs/reference/beautiful-ui/LoadingState.tsx (its pixel-grid wavefront and
 * ticking timer) — the local backend genuinely takes 60-90s per query, so a
 * live "how long has this actually been running" signal is worth having
 * while the step list is still mid-flight.
 */

export type ThinkingStage = 'thinking' | 'querying' | 'preparing' | 'done'

// Only 2 steps shown, not 3: the route runs the query and builds `resultFrame`
// *before* opening the SSE stream, then emits `sql` and `result` back-to-back
// with no real gap (app/api/chat/route.ts) — so `querying`→`preparing` never
// represents an independently-waited-out duration on the client's clock, only
// `thinking`→`querying` (the SQL-generation call) does. A 3-step list made
// that look like a bug (steps "skipping" instead of animating in sequence).
const STEPS: { key: Exclude<ThinkingStage, 'thinking'>; label: string }[] = [
  { key: 'querying', label: 'Understanding the question' },
  { key: 'done', label: 'Querying your transactions' },
]

const STAGE_ORDER: ThinkingStage[] = ['thinking', 'querying', 'preparing', 'done']

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-ink-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <span
      className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2 animate-spin"
    />
  )
}

function PendingDot() {
  return <span className="size-3 shrink-0 rounded-full border-[1.5px] border-line" />
}

// 3x3 chevron wavefront, adapted from LoadingState's "Drive" pattern.
const PIXEL_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3
  return (c + Math.abs(r - 1)) * 90
})

function PixelLoader() {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {PIXEL_DELAYS.map((delay, index) => (
        <span
          key={index}
          className="size-[4px] rounded-[1px]"
          style={{ opacity: 0.15, animation: `ydb-pixel-on 650ms ease-in-out ${delay}ms infinite` }}
        />
      ))}
    </span>
  )
}

function useLiveSeconds(active: boolean): number {
  const startRef = useRef<number | null>(null)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) return
    if (startRef.current === null) startRef.current = performance.now()
    const id = setInterval(() => {
      setSeconds((performance.now() - startRef.current!) / 1000)
    }, 100)
    return () => clearInterval(id)
  }, [active])
  return seconds
}

export function ChatThinkingTrace({ stage, elapsedMs }: { stage: ThinkingStage; elapsedMs: number }) {
  const working = stage !== 'done'
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const expanded = manualExpanded ?? working
  const traceRef = useRef<HTMLDivElement>(null)
  const [lineHeight, setLineHeight] = useState(0)
  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight)
  }, [stage, expanded])

  const currentIndex = STAGE_ORDER.indexOf(stage)
  const seconds = Math.max(1, Math.round(elapsedMs / 1000))
  const liveSeconds = useLiveSeconds(working)

  return (
    <div className="flex w-full max-w-95 flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded((current) => !(current ?? working))}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-hover-2"
      >
        {working ? (
          <PixelLoader />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--color-ink-3)">
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
        )}
        <span role="status" className="contents">
          {working ? (
            <>
              <span
                className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
                style={{
                  backgroundImage: 'linear-gradient(90deg, var(--color-ink-3) 35%, var(--color-ink) 50%, var(--color-ink-3) 65%)',
                  backgroundSize: '200% 100%',
                  animation: 'ydb-shimmer-text 1.4s linear infinite',
                }}
              >
                Thinking
              </span>
              <span className="font-mono text-[12px] text-ink-3 tabular-nums">{liveSeconds.toFixed(1)}s</span>
            </>
          ) : (
            <span className="text-[13px] font-medium whitespace-nowrap text-ink-2" style={{ animation: 'ydb-fade-up 350ms ease-out both' }}>
              Thought for {seconds}s
            </span>
          )}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0, transitionTimingFunction: 'var(--ease-out)' }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line"
              style={{ top: -8, height: lineHeight ? lineHeight - 2 : 0, transition: 'height 500ms var(--ease-out)' }}
            />
            <div ref={traceRef} className="flex flex-col gap-1 py-1">
              {(() => {
                const doneFlags = STEPS.map((step) => currentIndex >= STAGE_ORDER.indexOf(step.key))
                const firstActiveIndex = doneFlags.indexOf(false)
                return STEPS.map((step, i) => {
                  const done = doneFlags[i]
                  const active = i === firstActiveIndex
                  return (
                    <div
                      key={step.key}
                      className="flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left"
                      style={{ animation: `ydb-fade-up 320ms var(--ease-out) ${i * 120}ms both` }}
                    >
                      {done ? <CheckIcon /> : active ? <SpinnerIcon /> : <PendingDot />}
                      <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{step.label}</span>
                    </div>
                  )
                })
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
