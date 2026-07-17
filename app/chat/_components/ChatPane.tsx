'use client'

import { useEffect, useRef, useState } from 'react'
import { MessageCircle, SendHorizonal, AlertCircle, Square, Copy, Check } from 'lucide-react'
import { ThinkingLoader } from '@/app/_components/ThinkingLoader'

export type Message = {
  role: 'user' | 'assistant'
  text: string
  sql?: string
  error?: boolean
  /** Raw technical detail (SQLite error etc.) shown in a collapsible section
   *  under a friendly error headline. */
  errorDetail?: string
}

export function ChatPane({
  sessionId,
  initialMessages,
  onResponseComplete,
}: {
  sessionId: number | null
  initialMessages: Message[]
  /** Called once after a response finishes streaming and is persisted, so the
   *  sidebar can refresh titles/timestamps — NOT per streamed chunk. */
  onResponseComplete?: () => void
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [focused, setFocused] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sessionIdRef = useRef<number | null>(sessionId)
  const abortRef = useRef<AbortController | null>(null)

  // Sync when session changes
  useEffect(() => {
    setMessages(initialMessages)
    sessionIdRef.current = sessionId
    setInput('')
  }, [sessionId, initialMessages])

  useEffect(() => {
    const thread = threadRef.current
    // Scrolling instantly on every streamed token avoids the jitter `smooth`
    // causes when new frames arrive faster than the scroll animation. Only
    // auto-scroll if the user hasn't scrolled away to read earlier messages.
    const nearBottom = !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: loading ? 'auto' : 'smooth' })
    }
  }, [messages, loading])

  const updateMessages = (updater: (prev: Message[]) => Message[]) => {
    setMessages((prev) => updater(prev))
  }

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

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ message: 'Unknown error' }))
        updateMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = {
            role: 'assistant',
            text: 'The generated query failed.',
            errorDetail: err.message ?? res.statusText,
            sql: err.sql,
            error: true,
          }
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
                  text: 'The generated query failed.',
                  errorDetail: event.message,
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
        // Refresh the sidebar exactly once, after persistence completes — not
        // on every streamed token (the previous onMessagesChange-per-render
        // pattern refetched /api/chat-sessions for each chunk).
        saveMessages()
          .catch(() => { /* non-critical */ })
          .finally(() => onResponseComplete?.())
      }

    } catch (err) {
      // User pressed Stop — keep whatever streamed so far, no error banner.
      if (err instanceof Error && err.name === 'AbortError') {
        updateMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant' && !last.text) {
            next[next.length - 1] = { ...last, text: '_(stopped)_' }
          }
          return next
        })
      } else {
        updateMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = {
            role: 'assistant',
            text: 'Could not reach the server.',
            errorDetail: err instanceof Error ? err.message : String(err),
            error: true,
          }
          return next
        })
      }
    } finally {
      abortRef.current = null
      setLoading(false)
      textareaRef.current?.focus()
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  async function copyMessage(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex((c) => (c === index ? null : c)), 1500)
    } catch { /* clipboard unavailable */ }
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
      {/* Message thread — aria-live="polite" so screen readers announce new/streaming
          messages without interrupting (assertive would be too aggressive mid-stream) */}
      <div ref={threadRef} role="log" aria-live="polite" aria-relevant="additions text" style={{
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
                  padding: '10px 14px',
                  borderRadius: '12px',
                  backgroundColor: 'var(--bg-notify-error)',
                  border: '1px solid var(--border-warm)',
                  fontSize: '13px',
                  lineHeight: 1.5,
                  color: 'var(--tx-error)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                    <AlertCircle size={16} strokeWidth={2} style={{ flexShrink: 0, marginTop: '1px' }} />
                    <span>{msg.text}</span>
                  </div>
                  {msg.errorDetail && (
                    <details style={{ marginTop: '8px' }}>
                      <summary style={{ cursor: 'pointer', fontSize: '12px', opacity: 0.85, userSelect: 'none' }}>
                        Technical detail
                      </summary>
                      <pre style={{
                        marginTop: '6px', padding: '8px 10px', borderRadius: '6px',
                        backgroundColor: 'var(--bg-card-alt)', border: '1px solid var(--border-warm)',
                        fontSize: '12px', color: 'var(--tx-secondary)', overflowX: 'auto',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace',
                      }}>
                        {msg.errorDetail}
                      </pre>
                    </details>
                  )}
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

              {msg.role === 'assistant' && !msg.error && msg.text && !(loading && i === messages.length - 1) && (
                <button
                  onClick={() => copyMessage(msg.text, i)}
                  aria-label="Copy answer"
                  style={{
                    marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px',
                    fontSize: '12px', color: 'var(--tx-secondary)', background: 'none',
                    border: 'none', cursor: 'pointer', padding: 0,
                  }}
                >
                  {copiedIndex === i ? <Check size={12} /> : <Copy size={12} />}
                  {copiedIndex === i ? 'Copied' : 'Copy'}
                </button>
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
            {loading ? (
              <button
                onClick={stop}
                aria-label="Stop generating"
                className="btn"
                style={{
                  width: '34px', height: '34px', borderRadius: '10px', border: 'none',
                  backgroundColor: 'var(--bg-nav-active)', color: 'var(--tx-nav-active)',
                  cursor: 'pointer', transition: 'background-color 0.15s, color 0.15s',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <Square size={14} strokeWidth={2} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim()}
                aria-label="Send message"
                className="btn"
                style={{
                  width: '34px', height: '34px', borderRadius: '10px', border: 'none',
                  backgroundColor: !input.trim() ? 'var(--border)' : 'var(--bg-nav-active)',
                  color: !input.trim() ? 'var(--tx-secondary)' : 'var(--tx-nav-active)',
                  cursor: !input.trim() ? 'not-allowed' : 'pointer',
                  transition: 'background-color 0.15s, color 0.15s',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <SendHorizonal size={16} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '11px', color: 'var(--tx-secondary)', opacity: 0.6 }}>
          Enter to send · Shift+Enter for new line
        </div>
      </div>
    </div>
  )
}

