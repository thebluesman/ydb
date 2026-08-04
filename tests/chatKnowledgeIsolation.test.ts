import { describe, expect, it, vi } from 'vitest'

// This test exists for one reason: ADR-0007's central decision — knowledge
// snippets are injected into the NARRATION prompt only, never into SQL
// generation — is true today only by construction. Nothing else in this
// suite would fail if a future edit to app/api/chat/route.ts started passing
// the knowledge block into generateSql(). This drives the real route handler
// with fetch mocked, and inspects both outgoing Ollama request bodies
// directly, so that specific regression can't land silently.

vi.mock('@/lib/prisma', () => ({
  prisma: {
    setting: {
      findFirst: async () => ({ value: 'AED' }),
      findMany: async () => [],
    },
    // The route reads the stored category vocabulary per turn (ADR-0008).
    // Empty here: this test is about what does and doesn't reach each prompt,
    // and an empty vocabulary leaves the SQL prompt exactly as it was.
    transaction: { findMany: async () => [] },
    // Same for the stored account-name vocabulary, and empty for the same
    // reason — an empty vocabulary renders no block at all.
    account: { findMany: async () => [] },
  },
  executeReadonlyQuery: () => ({ rows: [{ total: 42 }], truncated: false }),
}))

import { POST } from '@/app/api/chat/route'
import { buildKnowledgeBlock, KNOWLEDGE_PRECEDENCE_LINE, loadKnowledgeSnippets } from '@/lib/chatKnowledge'

type OllamaCall = { body: { system: string; prompt: string; stream: boolean; options?: Record<string, unknown> } }

describe('POST /api/chat — knowledge injection stays out of SQL generation (ADR-0007)', () => {
  it('injects the knowledge block into narration only, never SQL generation, and pins num_ctx there', async () => {
    const calls: OllamaCall[] = []

    const encoder = new TextEncoder()
    const narrationStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ response: 'ok' })}\n`))
        controller.close()
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        calls.push({ body })
        if (body.stream === false) {
          return new Response(JSON.stringify({ response: 'SELECT 1 AS total' }), { status: 200 })
        }
        return new Response(narrationStream, { status: 200 })
      }),
    )

    try {
      const request = new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({ question: 'how much did I spend?' }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      // SQL generation, Phase A verification (ADR-0025), narration.
      expect(calls).toHaveLength(3)

      const [sqlCall, verifyCall, narrationCall] = calls

      const block = buildKnowledgeBlock(loadKnowledgeSnippets('P0'))
      expect(block.length).toBeGreaterThan(0) // sanity: there is real content that could leak

      // SQL-generation call: no knowledge content, and its own pinned context
      // window (SQL_NUM_CTX) so an over-length prompt errors loudly instead of
      // being silently truncated from the front.
      expect(sqlCall.body.stream).toBe(false)
      expect(sqlCall.body.system).not.toContain(KNOWLEDGE_PRECEDENCE_LINE)
      expect(sqlCall.body.system).not.toContain(block)
      expect(sqlCall.body.prompt).not.toContain(block)
      expect(sqlCall.body.options?.num_ctx).toBe(16_384)

      // Verification call (ADR-0025): also no knowledge content — it is shown
      // the SQL as a claim to check, not the context the generator had.
      expect(verifyCall.body.stream).toBe(false)
      expect(verifyCall.body.system).not.toContain(KNOWLEDGE_PRECEDENCE_LINE)
      expect(verifyCall.body.system).not.toContain(block)
      expect(verifyCall.body.prompt).not.toContain(block)

      // Narration call: carries the knowledge block and the pinned context window.
      expect(narrationCall.body.stream).toBe(true)
      expect(narrationCall.body.system).toContain(KNOWLEDGE_PRECEDENCE_LINE)
      expect(narrationCall.body.system).toContain(block)
      expect(narrationCall.body.options?.num_ctx).toBe(16_384)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
