'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Select, useToast } from '@/app/_components/ui'
import { ROLE_META, annotateModel, LLM_DEFAULTS, type LlmRole } from '@/lib/llm-models'

type Setting = { key: string; value: string }
type HealthState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; models: string[] }
  | { status: 'error'; message: string }

const DEFAULT_VALUE = '__default__'

/**
 * Defaults-first model configuration. The two roles (extraction, chat) are
 * shown with their current value and a plain-English recommendation. Actually
 * changing them lives behind an "Advanced" disclosure that lists the installed
 * models (via GET /api/ollama/health, which proxies ${ollamaUrl}/api/tags),
 * annotating known-good ones. Unknown models are selectable but unannotated.
 */
export function ModelSettings({ initialSettings }: { initialSettings: Setting[] }) {
  const toast = useToast()
  const settingValue = (key: string) =>
    initialSettings.find((s) => s.key === key)?.value?.trim() ?? ''

  const [values, setValues] = useState<Record<string, string>>({
    extractionModel: settingValue('extractionModel'),
    chatModel: settingValue('chatModel'),
    ollamaUrl: settingValue('ollamaUrl'),
  })
  const [advanced, setAdvanced] = useState(false)
  const [health, setHealth] = useState<HealthState>({ status: 'idle' })

  const loadModels = async () => {
    setHealth({ status: 'loading' })
    try {
      const res = await fetch('/api/ollama/health')
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        setHealth({ status: 'ok', models: Array.isArray(data.models) ? data.models : [] })
      } else {
        setHealth({ status: 'error', message: data?.error ?? 'Ollama is not reachable' })
      }
    } catch {
      setHealth({ status: 'error', message: 'Could not reach Ollama' })
    }
  }

  const toggleAdvanced = () => {
    const next = !advanced
    setAdvanced(next)
    if (next && health.status === 'idle') loadModels()
  }

  const save = async (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }))
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      toast.success('Saved — takes effect on the next request')
    } catch (e) {
      toast.error(`Could not save: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const installed = health.status === 'ok' ? health.models : []

  const roleOptions = (role: LlmRole, current: string) => {
    const roleDefault = ROLE_META[role].default
    const names = new Set(installed)
    // Keep a configured-but-not-installed value visible so it isn't silently lost.
    if (current) names.add(current)
    const opts = [
      { value: DEFAULT_VALUE, label: `Default — ${roleDefault}` },
      ...[...names].sort().map((name) => {
        const note = annotateModel(name, role)
        const missing = installed.length > 0 && !installed.includes(name) ? ' — not installed' : ''
        return { value: name, label: note ? `${name} — ${note}` : `${name}${missing}` }
      }),
    ]
    return opts
  }

  const roleCard = (role: LlmRole) => {
    const meta = ROLE_META[role]
    const current = values[meta.settingKey]
    const effective = current || meta.default
    return (
      <div key={role} className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium" style={{ color: 'var(--tx-primary)' }}>{meta.label}</span>
          <span className="text-xs font-mono" style={{ color: 'var(--tx-secondary)' }}>
            {effective}{!current && ' (default)'}
          </span>
        </div>
        <p className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>{meta.recommendation}</p>
        {advanced && (
          <div className="pt-1">
            <Select
              value={current || DEFAULT_VALUE}
              onValueChange={(v) => save(meta.settingKey, v === DEFAULT_VALUE ? '' : v)}
              options={roleOptions(role, current)}
              ariaLabel={`${meta.label} selection`}
              size="sm"
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-6 pt-6 space-y-4" style={{ borderTop: '1px solid var(--border-warm)' }}>
      <div>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--tx-primary)' }}>Local models</h3>
        <p className="text-xs mt-0.5" style={{ color: 'var(--tx-secondary)' }}>
          Which Ollama models drive extraction and chat. The defaults work well; change them only if you know your box.
        </p>
      </div>

      {roleCard('extraction')}
      {roleCard('chat')}

      <button
        type="button"
        onClick={toggleAdvanced}
        className="btn flex items-center gap-1 text-xs font-medium transition-colors"
        style={{ color: 'var(--tx-secondary)' }}
      >
        {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Advanced
      </button>

      {advanced && (
        <div className="space-y-3 pl-1">
          {health.status === 'loading' && (
            <p className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>Loading installed models…</p>
          )}
          {health.status === 'error' && (
            <p className="text-xs" style={{ color: 'var(--tx-notify-error)' }}>
              {health.message}. Model lists above show only the currently-configured values.
            </p>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" style={{ color: 'var(--tx-primary)' }}>Ollama URL</label>
            <p className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>
              Leave blank to use {LLM_DEFAULTS.ollamaUrl} (or the OLLAMA_URL env var).
            </p>
            <input
              type="text"
              value={values.ollamaUrl}
              placeholder={LLM_DEFAULTS.ollamaUrl}
              onChange={(e) => setValues((v) => ({ ...v, ollamaUrl: e.target.value }))}
              onBlur={(e) => save('ollamaUrl', e.target.value.trim())}
              className="w-full px-3 py-2 text-sm rounded-[8px] outline-none font-mono"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
