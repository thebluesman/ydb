'use client'

import React, { useState } from 'react'
import { CheckCircle } from 'lucide-react'
import { ThinkingLoader } from '@/app/_components/ThinkingLoader'
import { FileDropzone } from './FileDropzone'
import { ReviewTable, type DraftTransaction } from './ReviewTable'
import { detectFormat, normalizeTransactions, type StatementFormat } from '@/lib/statementFormats'
import { findMatchingRule } from '@/lib/vendor-rule-match'
import { toCents } from '@/lib/money'

type Account = { id: number; name: string; currency: string; accountType: string }
type Category = { id: number; name: string; color: string }
type Phase = 'idle' | 'ocr' | 'parsing' | 'review' | 'done'

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  borderRadius: '8px',
}

export function UploadFlow({ accounts, categories }: { accounts: Account[]; categories: Category[] }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<number>(accounts[0]?.id ?? 0)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrPage, setOcrPage] = useState<{ current: number; total: number }>({ current: 0, total: 0 })
  const [drafts, setDrafts] = useState<DraftTransaction[]>([])
  const [error, setError] = useState('')
  const [committedCount, setCommittedCount] = useState(0)
  const [pdfPassword, setPdfPassword] = useState('')
  const [passwordPhase, setPasswordPhase] = useState<'none' | 'needed' | 'wrong'>('none')
  const abortRef = React.useRef<AbortController | null>(null)
  const [parseLog, setParseLog] = useState<string>('')

  const reset = () => {
    setPhase('idle'); setFile(null); setOcrProgress(0)
    setOcrPage({ current: 0, total: 0 }); setDrafts([]); setError('')
    setPdfPassword(''); setPasswordPhase('none')
  }

  const handleProcess = async () => {
    if (!file || !selectedAccountId) return
    setError(''); setPhase('ocr')
    let ocrText = ''

    try {
      if (file.type === 'application/pdf') {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()
        let pdf
        try {
          pdf = await pdfjsLib.getDocument({
            data: await file.arrayBuffer(),
            password: pdfPassword || undefined,
          }).promise
        } catch (e) {
          const isPasswordErr = e !== null && typeof e === 'object' && 'name' in e &&
            (e as { name: string }).name === 'PasswordException'
          if (isPasswordErr) {
            setPasswordPhase((e as unknown as { code: number }).code === 2 ? 'wrong' : 'needed')
            setPhase('idle')
            return
          }
          throw e
        }
        setOcrPage({ current: 0, total: pdf.numPages })

        // Lazy-initialised Tesseract worker — only created if a scanned page is found.
        type TesseractWorker = {
          recognize: (canvas: HTMLCanvasElement) => Promise<{ data: { text: string } }>
          terminate: () => Promise<unknown>
        }
        let ocrWorker: TesseractWorker | null = null

        console.log(`[ocr] PDF has ${pdf.numPages} page(s)`)
        for (let i = 1; i <= pdf.numPages; i++) {
          setOcrPage({ current: i, total: pdf.numPages }); setOcrProgress(0)
          const page = await pdf.getPage(i)
          const viewport = page.getViewport({ scale: 2 })

          // Prefer native text extraction — produces clean, compact text and uses far fewer tokens.
          // Fall back to Tesseract OCR only for scanned (image-only) pages.
          const textContent = await page.getTextContent()
          type TextItem = { str: string; hasEOL: boolean; transform: number[] }
          const textItems = (textContent.items as (TextItem | object)[])
            .filter((item): item is TextItem => 'str' in item && typeof (item as TextItem).str === 'string' && (item as TextItem).str.trim() !== '')

          if (textItems.length > 0) {
            // Reconstruct visual lines using y-coordinates rather than hasEOL.
            // hasEOL is unreliable — many PDFs set it on every item, which splits
            // multi-word descriptions across lines and confuses the LLM.
            // PDF y-coordinates increase upward, so top-of-page items have the
            // largest y. We sort into reading order and group by y-proximity.
            const LINE_Y_TOLERANCE = 3
            const sorted = [...textItems].sort((a, b) => {
              const yDiff = b.transform[5] - a.transform[5]
              if (Math.abs(yDiff) > LINE_Y_TOLERANCE) return yDiff  // different lines: top first
              return a.transform[4] - b.transform[4]                 // same line: left-to-right
            })
            const lines: string[][] = []
            let currentLine: string[] = []
            let prevY = sorted[0].transform[5]
            for (const item of sorted) {
              const y = item.transform[5]
              if (Math.abs(y - prevY) > LINE_Y_TOLERANCE) {
                if (currentLine.length > 0) lines.push(currentLine)
                currentLine = []
                prevY = y
              }
              currentLine.push(item.str)
            }
            if (currentLine.length > 0) lines.push(currentLine)
            const pageText = lines.map(l => l.join(' ').replace(/\s+/g, ' ').trim()).join('\n') + '\n'
            console.log(`[ocr] page ${i}: native text, ${pageText.length} chars, ${lines.length} lines`)
            ocrText += pageText
          } else {
            // Scanned page — fall back to Tesseract OCR
            if (!ocrWorker) {
              const { createWorker } = await import('tesseract.js')
              ocrWorker = (await createWorker('eng', 1, {
                logger: (m: { status: string; progress: number }) => {
                  if (m.status === 'recognizing text') setOcrProgress(Math.round(m.progress * 100))
                },
              })) as unknown as TesseractWorker
            }
            const canvas = document.createElement('canvas')
            canvas.width = viewport.width; canvas.height = viewport.height
            await page.render({ canvas, viewport }).promise
            ocrText += (await ocrWorker!.recognize(canvas)).data.text + '\n'
          }
        }
        if (ocrWorker) await ocrWorker.terminate()
      } else {
        setOcrPage({ current: 1, total: 1 })
        const { createWorker } = await import('tesseract.js')
        const worker = await createWorker('eng', 1, {
          logger: (m: { status: string; progress: number }) => {
            if (m.status === 'recognizing text') setOcrProgress(Math.round(m.progress * 100))
          },
        })
        ocrText = (await worker.recognize(file)).data.text
        await worker.terminate()
      }
    } catch (e) {
      setError(`OCR failed: ${String(e)}`); setPhase('idle'); return
    }

    if (!ocrText.trim()) {
      setError('No text could be extracted. Try a clearer image.'); setPhase('idle'); return
    }

    const fmt: StatementFormat = detectFormat(ocrText)
    setPasswordPhase('none')
    setPhase('parsing')
    setParseLog('Starting…')
    let accumulated = ''
    const abort = new AbortController()
    abortRef.current = abort
    const parseStart = performance.now()

    try {
      setParseLog(`Sending ${(ocrText.length / 1024).toFixed(1)} KB of text to Ollama…`)
      console.log('[ollama] request start — text length:', ocrText.length, 'chars, format:', fmt.type)
      const res = await fetch('/api/ollama', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ocrText, formatHint: fmt.type }),
        signal: abort.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? 'Ollama request failed')
      }
      console.log('[ollama] stream started')
      setParseLog('Receiving tokens…')
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let tokenCount = 0
      let lastLogAt = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const chunk = JSON.parse(line).message?.content ?? ''
            accumulated += chunk
            tokenCount++
            const elapsed = ((performance.now() - parseStart) / 1000).toFixed(1)
            if (tokenCount - lastLogAt >= 100) {
              lastLogAt = tokenCount
              console.log(`[ollama] ${tokenCount} tokens, ${accumulated.length} chars, ${elapsed}s`)
              setParseLog(`${tokenCount} tokens · ${accumulated.length} chars · ${elapsed}s`)
            }
          } catch { /* skip */ }
        }
      }
      const elapsed = ((performance.now() - parseStart) / 1000).toFixed(1)
      console.log(`[ollama] stream done — ${tokenCount} tokens, ${accumulated.length} chars, ${elapsed}s`)
      setParseLog(`Done — ${tokenCount} tokens in ${elapsed}s`)
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') { setPhase('idle'); setParseLog(''); return }
      setError(`Parsing failed: ${String(e)}`); setPhase('idle'); return
    }

    try {
      // The prompt ends with '[' to prime JSON array output, so prepend it back
      const clean = ('[' + accumulated).replace(/```json|```/g, '').trim()
      type RawTxn = { date: string; description: string; amount: number; category: string }
      let parsed: RawTxn[] = []
      const arrStart = clean.indexOf('[')
      const arrEnd = clean.lastIndexOf(']')
      if (arrStart !== -1 && arrEnd !== -1) {
        try {
          parsed = JSON.parse(clean.slice(arrStart, arrEnd + 1))
        } catch { /* fall through to salvage */ }
      }
      // Salvage path: walk the buffer and extract every well-formed top-level
      // object. The model occasionally emits a malformed entry mid-stream
      // (mismatched quotes, truncation); without this, one bad row would
      // discard the entire statement.
      if (!Array.isArray(parsed) || parsed.length === 0) {
        const salvaged: RawTxn[] = []
        let depth = 0, objStart = -1, inString = false, escape = false
        const src = arrStart !== -1 ? clean.slice(arrStart) : clean
        for (let i = 0; i < src.length; i++) {
          const c = src[i]
          if (escape) { escape = false; continue }
          if (c === '\\') { escape = true; continue }
          if (c === '"') { inString = !inString; continue }
          if (inString) continue
          if (c === '{') { if (depth === 0) objStart = i; depth++ }
          else if (c === '}') {
            depth--
            if (depth === 0 && objStart !== -1) {
              try {
                const obj = JSON.parse(src.slice(objStart, i + 1))
                if (obj && typeof obj === 'object' && 'description' in obj) salvaged.push(obj as RawTxn)
              } catch { /* skip malformed */ }
              objStart = -1
            }
          }
        }
        parsed = salvaged
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setError('The model found no transactions in this document.'); setPhase('idle'); return
      }
      const normalized = normalizeTransactions(parsed, fmt)
      const today = new Date().toISOString().split('T')[0]

      // Fetch patterns and apply them: set friendly description + category where matched
      let patterns: { id: number; pattern: string; matchType: string; vendor: string; category: string; direction: string; transactionType: string | null; minAmount: number | null; maxAmount: number | null; priority: number }[] = []
      try {
        const pr = await fetch('/api/vendor-rules')
        if (pr.ok) patterns = await pr.json()
      } catch { /* non-critical — fall back to raw descriptions */ }

      // Drafts keep amounts in major units for UI friendliness; the commit step
      // converts to integer cents at the API boundary.
      // rawSource is intentionally blank here — stashing 2 KB of OCR text per
      // row duplicated the same prefix across every transaction; the user
      // already has the source PDF if they need it.
      setDrafts(normalized.map((t) => {
        const rawDesc = t.originalDescription
        const amt = Number(t.amount) || 0
        // Rule min/maxAmount gates are in cents; compare against cents too.
        const match = patterns.length > 0 ? findMatchingRule(patterns, rawDesc, toCents(amt)) : null
        return {
          _id: crypto.randomUUID(),
          date: t.date ?? today,
          description: match ? match.vendor : rawDesc,
          originalDescription: rawDesc,
          amount: amt,
          transactionType: (match?.transactionType) ?? t.transactionType,
          category: match ? match.category : (t.category || 'Other'),
          accountId: selectedAccountId,
          notes: '',
          rawSource: '',
        }
      }))
      setPhase('review')
    } catch (e) {
      setError(`Could not parse model output.\n\n${accumulated.slice(0, 500)}\n\nError: ${String(e)}`)
      setPhase('idle')
    }
  }

  const handleCommit = async () => {
    const payload = drafts.map(({ _id: _, amount, ...t }) => ({
      ...t,
      amount: toCents(amount),
    }))
    const res = await fetch('/api/transactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error ?? 'Failed to save')
    }
    const { count } = await res.json()
    // Record the import (fire-and-forget)
    fetch('/api/import-records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file?.name ?? 'unknown', accountId: selectedAccountId, transactionCount: count }),
    }).catch(() => { /* non-critical */ })
    setCommittedCount(count)
    setPhase('done')
  }

  if (phase === 'done') {
    return (
      <div key="done" className="py-16 text-center space-y-4 rounded-[8px]" style={{ ...cardStyle, animation: 'ydb-page-in 0.25s cubic-bezier(0.22,1,0.36,1) both' }}>
        <CheckCircle size={40} style={{ color: 'var(--tx-success)', margin: '0 auto' }} />
        <h2 className="text-[22px] font-semibold" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
          {committedCount} transaction{committedCount !== 1 ? 's' : ''} saved
        </h2>
        <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>They are now in your ledger.</p>
        <button onClick={reset}
          className="px-[14px] py-[10px] rounded-[8px] text-sm font-semibold transition-colors duration-150 hover:text-error"
          style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}>
          Upload another
        </button>
      </div>
    )
  }

  if (phase === 'review') {
    return (
      <div key="review" className="p-6 rounded-[8px]" style={{ ...cardStyle, animation: 'ydb-page-in 0.25s cubic-bezier(0.22,1,0.36,1) both' }}>
        <ReviewTable drafts={drafts} accounts={accounts} categories={categories}
          onChange={setDrafts} onCommit={handleCommit} onDiscard={reset} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Account selector */}
      <div className="p-6 space-y-3 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px]" style={{ color: 'var(--tx-secondary)' }}>Account</p>
        {accounts.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>
            No accounts yet. <a href="/settings" style={{ color: '#f54e00', textDecoration: 'underline' }}>Configure accounts first.</a>
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => (
              <button key={a.id} onClick={() => setSelectedAccountId(a.id)} disabled={phase !== 'idle'}
                className="px-3 py-1.5 rounded-full text-sm transition-colors duration-150"
                style={selectedAccountId === a.id
                  ? { backgroundColor: 'var(--bg-selected)', color: 'var(--tx-selected)', border: '1px solid var(--bg-selected)' }
                  : { backgroundColor: 'var(--bg-btn)', color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }
                }>
                {a.name || `Account ${a.id}`}
                <span className="ml-1.5 text-xs opacity-50">
                  {a.accountType === 'personal_loan' ? 'Personal Loan'
                    : a.accountType === 'auto_loan' ? 'Auto Loan'
                    : a.accountType === 'credit' ? 'Credit'
                    : a.accountType.charAt(0).toUpperCase() + a.accountType.slice(1)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Drop zone */}
      <div className="p-6 space-y-5 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px]" style={{ color: 'var(--tx-secondary)' }}>Statement File</p>
        <FileDropzone file={file} onFile={setFile} onClear={() => setFile(null)} disabled={phase !== 'idle'} />

        {phase === 'ocr' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs" style={{ color: 'var(--tx-secondary)' }}>
              <span>Reading document{ocrPage.total > 1 ? ` — page ${ocrPage.current} of ${ocrPage.total}` : ''}…</span>
              <span className="font-mono">{ocrProgress}%</span>
            </div>
            <div className="h-[3px] rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border-warm)' }}>
              <div className="h-full rounded-full transition-all duration-200"
                style={{ width: `${ocrProgress}%`, backgroundColor: 'var(--progress-fg)' }} />
            </div>
          </div>
        )}

        {phase === 'parsing' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm" style={{ color: 'var(--tx-secondary)' }}>
                <ThinkingLoader />
                Qwen is thinking…
              </div>
              <button
                onClick={() => { abortRef.current?.abort(); setPhase('idle') }}
                className="text-sm px-3 py-1 rounded-[6px] transition-colors"
                style={{ color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
              >
                Cancel
              </button>
            </div>
            {parseLog && (
              <p className="text-xs font-mono" style={{ color: 'var(--tx-tertiary)' }}>{parseLog}</p>
            )}
          </div>
        )}

        {error && (
          <div className="text-sm px-4 py-3 rounded-[8px] whitespace-pre-wrap"
            style={{ backgroundColor: 'var(--bg-notify-error)', color: 'var(--tx-notify-error)' }}>
            {error}
          </div>
        )}

        {phase === 'idle' && passwordPhase === 'none' && (
          <button onClick={handleProcess} disabled={!file || !selectedAccountId}
            className="w-full py-[10px] px-[14px] rounded-[8px] text-sm font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--color-accent)', color: '#fff' }}>
            Extract Transactions
          </button>
        )}

        {phase === 'idle' && passwordPhase !== 'none' && (
          <div className="space-y-3 pt-1">
            <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>
              {passwordPhase === 'wrong'
                ? 'Incorrect password. Try again.'
                : 'This PDF is password-protected. Enter the password to continue.'}
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={pdfPassword}
                onChange={(e) => setPdfPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleProcess()}
                placeholder="PDF password"
                autoFocus
                className="flex-1 px-3 py-2 text-sm rounded-[8px] outline-none"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              />
              <button onClick={handleProcess} disabled={!pdfPassword}
                className="px-[14px] py-[10px] rounded-[8px] text-sm font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}>
                Unlock
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

