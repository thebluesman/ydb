'use client'

import { useEffect, useRef, useState } from 'react'
import { MessageCircle, SendHorizonal, AlertCircle } from 'lucide-react'

export type Message = {
  role: 'user' | 'assistant'
  text: string
  sql?: string
  error?: boolean
}

export function ChatPane({
  sessionId,
  initialMessages,
  onMessagesChange,
}: {
  sessionId: number | null
  initialMessages: Message[]
  onMessagesChange?: (messages: Message[]) => void
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [focused, setFocused] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sessionIdRef = useRef<number | null>(sessionId)

  // Sync when session changes
  useEffect(() => {
    setMessages(initialMessages)
    sessionIdRef.current = sessionId
    setInput('')
  }, [sessionId, initialMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const updateMessages = (updater: (prev: Message[]) => Message[]) => {
    setMessages((prev) => updater(prev))
  }

  useEffect(() => {
    onMessagesChange?.(messages)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  async function send() {
    const question = input.trim()
    if (!question || loading) return

    setInput('')
    setLoading(true)

    const history = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, text: m.text }))

    updateMessages((prev) => [
      ...prev,
      { role: 'user', text: question },
      { role: 'assistant', text: '', sql: undefined },
    ])

    let accumulatedText = ''
    let accumulatedSql: string | undefined

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history }),
      })

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ message: 'Unknown error' }))
        updateMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = { role: 'assistant', text: err.message ?? res.statusText, error: true }
          return next
        })
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'sql') {
              accumulatedSql = event.sql
              updateMessages((prev) => {
                const next = [...prev]
                next[next.length - 1] = { ...next[next.length - 1], sql: event.sql }
                return next
              })
            } else if (event.type === 'token') {
              accumulatedText += event.response ?? ''
              updateMessages((prev) => {
                const next = [...prev]
                const last = next[next.length - 1]
                next[next.length - 1] = { ...last, text: last.text + (event.response ?? '') }
                return next
              })
            } else if (event.type === 'error') {
              updateMessages((prev) => {
                const next = [...prev]
                const last = next[next.length - 1]
                next[next.length - 1] = {
                  ...last,
                  text: event.message,
                  sql: event.sql ?? last.sql,
                  error: true,
                }
                return next
              })
            }
          } catch { /* skip malformed */ }
        }
      }

      // Persist messages to DB (fire-and-forget, only if not an error)
      if (accumulatedText && sessionIdRef.current !== null) {
        const sid = sessionIdRef.current
        const saveMessages = async () => {
          await fetch(`/api/chat-sessions/${sid}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'user', text: question }),
          })
          await fetch(`/api/chat-sessions/${sid}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'assistant', text: accumulatedText, sql: accumulatedSql }),
          })
          // Auto-title from first user message
          if (history.length === 0) {
            await fetch(`/api/chat-sessions/${sid}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: question.slice(0, 60) }),
            })
          }
        }
        saveMessages().catch(() => { /* non-critical */ })
      }

    } catch (err) {
      updateMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = {
          role: 'assistant',
          text: err instanceof Error ? err.message : 'Failed to reach server',
          error: true,
        }
        return next
      })
    } finally {
      setLoading(false)
      textareaRef.current?.focus()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minHeight: 0,
      maxWidth: '760px',
      width: '100%',
      margin: '0 auto',
      padding: '0 16px',
    }}>
      {/* Message thread */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        paddingTop: '24px',
        paddingBottom: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}>
        {messages.length === 0 && (
          <div style={{
            margin: 'auto',
            textAlign: 'center',
            color: 'var(--tx-secondary)',
            fontSize: '14px',
            lineHeight: 1.6,
          }}>
            <div style={{ marginBottom: '12px', color: 'var(--tx-secondary)', display: 'flex', justifyContent: 'center' }}>
              <MessageCircle size={32} strokeWidth={1.5} />
            </div>
            <div style={{ fontWeight: 600, marginBottom: '6px', color: 'var(--tx-primary)' }}>
              Ask about your finances
            </div>
            <div>Try: &quot;How much did I spend last month?&quot; or &quot;What are my top categories this year?&quot;</div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{ maxWidth: '85%' }}>
              {msg.error ? (
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '10px 14px',
                  borderRadius: '12px',
                  backgroundColor: 'var(--bg-notify-error)',
                  border: '1px solid var(--border-warm)',
                  fontSize: '13px',
                  lineHeight: 1.5,
                  color: 'var(--tx-error)',
                }}>
                  <AlertCircle size={15} strokeWidth={2} style={{ flexShrink: 0, marginTop: '1px' }} />
                  <span>{msg.text}</span>
                </div>
              ) : (
                <div style={{
                  padding: '10px 14px',
                  borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  backgroundColor: msg.role === 'user' ? 'var(--bg-nav-active)' : 'var(--bg-card)',
                  color: msg.role === 'user' ? 'var(--tx-nav-active)' : 'var(--tx-primary)',
                  border: msg.role === 'assistant' ? '1px solid var(--border-warm)' : 'none',
                  fontSize: '14px',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {msg.role === 'assistant' && !msg.text && loading && i === messages.length - 1 ? (
                    <ThinkingLoader />
                  ) : (
                    msg.text || '\u200b'
                  )}
                </div>
              )}

              {msg.role === 'assistant' && msg.sql && (
                <details style={{ marginTop: '6px' }}>
                  <summary style={{
                    cursor: 'pointer',
                    fontSize: '12px',
                    color: 'var(--tx-secondary)',
                    userSelect: 'none',
                    listStyle: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}>
                    <span>▸</span> Show SQL
                  </summary>
                  <pre style={{
                    marginTop: '6px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--bg-card-alt)',
                    border: '1px solid var(--border-warm)',
                    fontSize: '12px',
                    color: 'var(--tx-secondary)',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontFamily: 'ui-monospace, monospace',
                  }}>
                    {msg.sql}
                  </pre>
                </details>
              )}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input composer */}
      <div style={{ paddingBottom: '20px', paddingTop: '8px' }}>
        <div style={{
          border: focused ? '1px solid var(--border-warm-strong)' : '1px solid var(--border)',
          borderRadius: '16px',
          backgroundColor: 'var(--bg-card)',
          boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your transactions…"
            rows={1}
            disabled={loading}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="composer-textarea"
            style={{
              resize: 'none',
              padding: '14px 16px 8px',
              border: 'none',
              backgroundColor: 'transparent',
              color: 'var(--tx-primary)',
              fontSize: '14px',
              lineHeight: 1.6,
              outline: 'none',
              fontFamily: 'inherit',
              overflow: 'hidden',
              minHeight: '44px',
              maxHeight: '140px',
              width: '100%',
            }}
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`
            }}
          />
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '8px 10px',
          }}>
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '10px',
                border: 'none',
                backgroundColor: loading || !input.trim() ? 'var(--border)' : 'var(--bg-nav-active)',
                color: loading || !input.trim() ? 'var(--tx-secondary)' : 'var(--tx-nav-active)',
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.15s, color 0.15s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <SendHorizonal size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '11px', color: 'var(--tx-secondary)', opacity: 0.6 }}>
          Enter to send · Shift+Enter for new line
        </div>
      </div>
    </div>
  )
}

function ThinkingLoader() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const SIZE = 24
    const DPR = window.devicePixelRatio || 1
    canvas.width = SIZE * DPR
    canvas.height = SIZE * DPR
    canvas.style.width = `${SIZE}px`
    canvas.style.height = `${SIZE}px`
    const S = (SIZE * DPR) / 100 // scale from 100-unit viewBox to canvas pixels

    const cfg = {
      roseA: 9.2, roseABoost: 0.6, roseBreathBase: 0.72, roseBreathBoost: 0.28, roseScale: 3.25,
      particleCount: 78, trailSpan: 0.32,
      durationMs: 5400, rotationDurationMs: 28000, pulseDurationMs: 4500,
    }

    function pt(progress: number, ds: number) {
      const t = progress * Math.PI * 2
      const a = cfg.roseA + ds * cfg.roseABoost
      const r = a * (cfg.roseBreathBase + ds * cfg.roseBreathBoost) * Math.cos(4 * t)
      return {
        x: 50 + Math.cos(t) * r * cfg.roseScale,
        y: 50 + Math.sin(t) * r * cfg.roseScale,
      }
    }

    function norm(p: number) { return ((p % 1) + 1) % 1 }

    const particleColor = { r: 245, g: 78, b: 0 } // #f54e00 accent

    let animId: number
    const start = performance.now()
    const c = canvas
    const x = ctx

    function draw(now: number) {
      const t = now - start
      const ds = 0.52 + ((Math.sin((t / cfg.pulseDurationMs) * Math.PI * 2 + 0.55) + 1) / 2) * 0.48
      const rot = -(t / cfg.rotationDurationMs) * Math.PI * 2
      const progress = (t % cfg.durationMs) / cfg.durationMs

      x.clearRect(0, 0, c.width, c.height)
      x.save()
      x.translate(c.width / 2, c.height / 2)
      x.rotate(rot)
      x.translate(-c.width / 2, -c.height / 2)

      // Ghost path
      x.beginPath()
      for (let i = 0; i <= 480; i++) {
        const p = pt(i / 480, ds)
        i === 0 ? x.moveTo(p.x * S, p.y * S) : x.lineTo(p.x * S, p.y * S)
      }
      const { r, g, b } = particleColor
      x.strokeStyle = `rgba(${r},${g},${b},0.085)`
      x.lineWidth = 4.6 * S
      x.stroke()

      // Particle trail
      for (let i = 0; i < cfg.particleCount; i++) {
        const tail = i / (cfg.particleCount - 1)
        const p = pt(norm(progress - tail * cfg.trailSpan), ds)
        const fade = Math.pow(1 - tail, 0.56)
        x.beginPath()
        x.arc(p.x * S, p.y * S, (0.9 + fade * 2.7) * S, 0, Math.PI * 2)
        x.fillStyle = `rgba(${r},${g},${b},${0.04 + fade * 0.96})`
        x.fill()
      }

      x.restore()
      animId = requestAnimationFrame(draw)
    }

    animId = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(animId) }
  }, [])

  return <canvas ref={canvasRef} style={{ display: 'block' }} />
}
