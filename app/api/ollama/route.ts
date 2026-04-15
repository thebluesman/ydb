export const runtime = 'nodejs'

import { prisma } from '@/lib/prisma'

async function buildSystemPrompt(formatHint?: string): Promise<string> {
  const [dbCategories, vendorRules, learnedTxns] = await Promise.all([
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    prisma.vendorRule.findMany({ orderBy: [{ priority: 'asc' }, { vendor: 'asc' }] }),
    // Top 60 most-recently-committed distinct description→category pairs
    prisma.transaction.findMany({
      where: { status: 'committed' },
      select: { description: true, originalDescription: true, category: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
  ])

  const categoryNames = [
    ...new Set([...dbCategories.map((c) => c.name), 'Income', 'Other']),
  ].join(', ')

  // Build explicit vendor dictionary from VendorRule table
  let dictionary = ''
  if (vendorRules.length > 0) {
    const lines = vendorRules.map((r) => {
      const typeLabel = r.matchType === 'contains' ? 'contains' : r.matchType
      let line = `  - ${typeLabel} "${r.pattern}" → ${r.category}  (${r.vendor})`
      const constraints: string[] = []
      if (r.direction === 'debit')   constraints.push('debit only')
      if (r.direction === 'credit')  constraints.push('credit only')
      if (r.minAmount != null)       constraints.push(`amount ≥ ${r.minAmount}`)
      if (r.maxAmount != null)       constraints.push(`amount ≤ ${r.maxAmount}`)
      if (constraints.length)        line += `  [${constraints.join(', ')}]`
      return line
    })
    dictionary += `\nVendor dictionary — apply each rule when the description matches the rule type (case-insensitive). Higher-priority rules (listed first) take precedence:\n${lines.join('\n')}`
  }

  // Supplement with learned patterns from committed transactions (deduplicated)
  const seen = new Set(vendorRules.map((r) => r.pattern.toLowerCase()))
  const learnedLines: string[] = []
  for (const t of learnedTxns) {
    const raw = t.originalDescription ?? t.description
    const key = raw.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      learnedLines.push(`  - "${raw}" → ${t.category}`)
      if (learnedLines.length >= 60) break
    }
  }
  if (learnedLines.length > 0) {
    dictionary += `\nLearned patterns from past transactions (use as soft guidance):\n${learnedLines.join('\n')}`
  }

  const base = `You are a data extraction specialist for financial transactions.
Output ONLY a valid JSON array of objects. Do not include markdown code blocks, explanations, or conversational filler.
Each object must have exactly these fields: { "date": "YYYY-MM-DD", "description": string, "amount": number, "category": string }
Categories must be one of: ${categoryNames}

Description extraction rules:
- A transaction's description may span multiple consecutive lines in the source document. Concatenate all lines that belong to a single transaction into one description string (space-separated). Do not truncate at the first line.
- Include reference numbers, merchant details, and any supplementary text that appears as part of the same transaction entry.
- Strip leading/trailing whitespace and normalise internal whitespace to single spaces.${dictionary}`

  if (formatHint === 'credit-card') {
    return base + `

This is a CREDIT CARD statement with a single Amount column.
- Plain positive numbers are EXPENSES: output as NEGATIVE amounts (e.g. 46.01 → -46.01).
- Numbers with a "CR" suffix are credits/payments: output as POSITIVE amounts (e.g. 1730.00CR → 1730.00).
- "PAYMENT RECEIVED" or "TRANSFER PAYMENT RECEIVED" → output as POSITIVE amount, any category.
- "Profit earned" or "Discretionary Reward" → category: Income, output as POSITIVE amount.
- SKIP entirely (do not include in output): OPENING BALANCE, PREVIOUS BALANCE, END OF STATEMENT, and any footer summary rows.`
  }

  if (formatHint === 'bank-account') {
    return base + `

This is a BANK ACCOUNT statement with separate Debit and Credit columns.
- Amount in the Debit column = money leaving the account → output as NEGATIVE amount.
- Amount in the Credit column = money entering the account → output as POSITIVE amount.
- "CREDIT CARD PAYMENT" → any category.
- "BANKNET TRANSFER" → any category.
- SKIP entirely: BROUGHT FORWARD, CARRIED FORWARD.`
  }

  return base + `\nUse negative amounts for debits/expenses, positive for credits/income.`
}

export async function POST(request: Request) {
  const { text, formatHint } = await request.json()

  if (!text || typeof text !== 'string') {
    return new Response(JSON.stringify({ error: 'text field required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434'
  const model = process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:14b'

  const systemPrompt = await buildSystemPrompt(formatHint)

  let ollamaResponse: Response
  try {
    ollamaResponse = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Extract all transactions from this bank statement text:\n\n${text}` },
          { role: 'assistant', content: '[' },
        ],
        stream: true,
        options: { num_ctx: 32768, num_predict: -1 },
      }),
    })
  } catch {
    return new Response(
      JSON.stringify({ error: 'Could not connect to Ollama. Is it running at ' + ollamaUrl + '?' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  if (!ollamaResponse.ok || !ollamaResponse.body) {
    return new Response(
      JSON.stringify({ error: `Ollama returned ${ollamaResponse.status}` }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Stream Ollama's NDJSON response directly to the client to avoid timeouts
  const stream = new ReadableStream({
    async start(controller) {
      const reader = ollamaResponse.body!.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}
