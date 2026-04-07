'use client'

import { Plus, X } from 'lucide-react'

type ChatSession = {
  id: number
  title: string
  updatedAt: string
  messages: { text: string }[]
}

function relativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ChatSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
}: {
  sessions: ChatSession[]
  activeSessionId: number | null
  onSelectSession: (id: number) => void
  onNewSession: () => void
  onDeleteSession: (id: number) => void
}) {
  return (
    <div
      className="flex flex-col shrink-0"
      style={{
        width: '220px',
        borderRight: '1px solid var(--border-warm)',
        backgroundColor: 'var(--bg-nav)',
        overflowY: 'auto',
      }}
    >
      <div className="p-3">
        <button
          onClick={onNewSession}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-[8px] text-sm font-medium transition-colors duration-150"
          style={{
            backgroundColor: 'var(--bg-btn)',
            border: '1px solid var(--border-warm)',
            color: 'var(--tx-primary)',
          }}
        >
          <Plus size={14} />
          New Chat
        </button>
      </div>

      <div className="flex-1 px-2 pb-3 space-y-0.5">
        {sessions.length === 0 && (
          <p className="px-2 py-3 text-xs" style={{ color: 'var(--tx-faint)' }}>No chats yet</p>
        )}
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId
          return (
            <div
              key={s.id}
              className="group flex items-start gap-1 px-2 py-2 rounded-[6px] cursor-pointer transition-colors duration-100"
              style={{
                backgroundColor: isActive ? 'var(--bg-nav-active)' : 'transparent',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)' }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent' }}
              onClick={() => onSelectSession(s.id)}
            >
              <div className="flex-1 min-w-0">
                <p
                  className="text-xs font-medium truncate leading-tight"
                  style={{ color: isActive ? 'var(--tx-nav-active)' : 'var(--tx-primary)' }}
                >
                  {s.title}
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--tx-faint)' }}>
                  {relativeTime(s.updatedAt)}
                </p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id) }}
                className="opacity-0 group-hover:opacity-100 transition-opacity duration-100 mt-0.5 shrink-0"
                style={{ color: 'var(--tx-tertiary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--tx-error)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--tx-tertiary)')}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
