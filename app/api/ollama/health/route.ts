export const runtime = 'nodejs'

import { getLlmConfig } from '@/lib/llm-config'

// Lightweight liveness probe for Ollama, doubling as the model-list proxy for
// the Settings UI. The UI uses this to show a clear "Ollama is not running"
// state up front instead of failing mid-generation, and to populate the
// Advanced model picker. Pings ${ollamaUrl}/api/tags (resolved from the same
// Setting→env→default precedence the generation routes use) with a short
// timeout and reports reachability plus the list of installed model names.
export async function GET() {
  const { ollamaUrl } = await getLlmConfig()

  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      return Response.json(
        { ok: false, url: ollamaUrl, error: `Ollama returned ${res.status}` },
        { status: 503 },
      )
    }
    const data = await res.json().catch(() => ({}))
    const models = Array.isArray(data?.models)
      ? (data.models as { name?: string }[]).map((m) => m.name).filter(Boolean)
      : []
    return Response.json({ ok: true, url: ollamaUrl, models })
  } catch {
    return Response.json(
      { ok: false, url: ollamaUrl, error: 'Could not connect to Ollama' },
      { status: 503 },
    )
  }
}
