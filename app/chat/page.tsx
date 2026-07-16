'use client'

import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { ChatSidebar, MobileChatDrawer } from './_components/ChatSidebar'
import { ChatPane, type Message } from './_components/ChatPane'

type ChatSession = {
  id: number
  title: string
  updatedAt: string
  messages: { text: string }[]
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [activeMessages, setActiveMessages] = useState<Message[]>([])
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)

  const loadSession = (id: number) => {
    fetch(`/api/chat-sessions/${id}`)
      .then((r) => r.json())
      .then((session: { id: number; title: string; updatedAt: string; messages: Array<{ role: string; text: string; sql?: string }> }) => {
        setActiveSessionId(session.id)
        setActiveMessages(
          session.messages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            text: m.text,
            sql: m.sql,
          }))
        )
      })
      .catch(() => {})
  }

  // Load sessions on mount; auto-create one if none exist
  useEffect(() => {
    fetch('/api/chat-sessions')
      .then((r) => r.json())
      .then(async (data: ChatSession[]) => {
        if (data.length > 0) {
          setSessions(data)
          loadSession(data[0].id)
        } else {
          // Auto-create the first session
          const res = await fetch('/api/chat-sessions', { method: 'POST' })
          const session = await res.json()
          setSessions([session])
          setActiveSessionId(session.id)
        }
      })
      .catch(() => {})
  }, [])

  const handleSelectSession = (id: number) => {
    if (id === activeSessionId) return
    loadSession(id)
  }

  const handleNewSession = async () => {
    try {
      const res = await fetch('/api/chat-sessions', { method: 'POST' })
      const session = await res.json()
      setSessions((prev) => [session, ...prev])
      setActiveSessionId(session.id)
      setActiveMessages([])
    } catch {}
  }

  const handleDeleteSession = async (id: number) => {
    try {
      await fetch(`/api/chat-sessions/${id}`, { method: 'DELETE' })
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (activeSessionId === id) {
        const remaining = sessions.filter((s) => s.id !== id)
        if (remaining.length > 0) {
          loadSession(remaining[0].id)
        } else {
          setActiveSessionId(null)
          setActiveMessages([])
        }
      }
    } catch {}
  }

  const handleResponseComplete = () => {
    // Refresh session list to get updated titles/timestamps — called once per
    // completed response, not per streamed token.
    fetch('/api/chat-sessions')
      .then((r) => r.json())
      .then((data: ChatSession[]) => setSessions(data))
      .catch(() => {})
  }

  const activeTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? 'Chat'

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>
      <div
        className="md:hidden flex items-center gap-2 px-4 py-2.5 shrink-0"
        style={{ borderBottom: '1px solid var(--border-warm)' }}
      >
        <button
          onClick={() => setMobileDrawerOpen(true)}
          aria-label="Open chat sessions"
          className="flex items-center gap-1.5 text-sm"
          style={{ color: 'var(--tx-secondary)' }}
        >
          <PanelLeft size={16} />
        </button>
        <span className="text-sm font-medium truncate" style={{ color: 'var(--tx-primary)' }}>{activeTitle}</span>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ChatSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
        />
        <MobileChatDrawer
          open={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
        />
        <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
          <ChatPane
            sessionId={activeSessionId}
            initialMessages={activeMessages}
            onResponseComplete={handleResponseComplete}
          />
        </div>
      </div>
    </div>
  )
}
