'use client'

import { useEffect, useState } from 'react'
import { ChatSidebar } from './_components/ChatSidebar'
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

  const handleMessagesChange = (messages: Message[]) => {
    // Refresh session list to get updated titles/timestamps
    fetch('/api/chat-sessions')
      .then((r) => r.json())
      .then((data: ChatSession[]) => setSessions(data))
      .catch(() => {})
    setActiveMessages(messages)
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <ChatSidebar
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
          onMessagesChange={handleMessagesChange}
        />
      </div>
    </div>
  )
}
