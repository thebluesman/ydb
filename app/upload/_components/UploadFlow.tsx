'use client'

import { useState, useEffect, useRef } from 'react'
import { CheckCircle } from 'lucide-react'
import { FileDropzone } from './FileDropzone'
import { ReviewTable, type DraftTransaction } from './ReviewTable'
import { detectFormat, normalizeTransactions, type StatementFormat } from '@/lib/statementFormats'
import { findMatchingRule } from '@/lib/vendor-rule-match'

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

        // Lazy-initialised Tesseract worker — only created if a scanned page is found
        let ocrWorker: { recognize: (canvas: HTMLCanvasElement) => Promise<{ data: { text: string } }>; terminate: () => Promise<void> } | null = null

        for (let i = 1; i <= pdf.numPages; i++) {
          setOcrPage({ current: i, total: pdf.numPages }); setOcrProgress(0)
          const page = await pdf.getPage(i)
          const viewport = page.getViewport({ scale: 2 })

          // Prefer native text extraction — produces clean, compact text and uses far fewer tokens.
          // Fall back to Tesseract OCR only for scanned (image-only) pages.
          const textContent = await page.getTextContent()
          type TextItem = { str: string; hasEOL: boolean }
          const textItems = (textContent.items as (TextItem | object)[])
            .filter((item): item is TextItem => 'str' in item && typeof (item as TextItem).str === 'string' && (item as TextItem).str.trim() !== '')

          if (textItems.length > 0) {
            // Native text — join items with spaces; EOL items append a newline
            ocrText += textItems.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('') + '\n'
          } else {
            // Scanned page — fall back to Tesseract OCR
            if (!ocrWorker) {
              const { createWorker } = await import('tesseract.js')
              ocrWorker = await createWorker('eng', 1, {
                logger: (m: { status: string; progress: number }) => {
                  if (m.status === 'recognizing text') setOcrProgress(Math.round(m.progress * 100))
                },
              })
            }
            const canvas = document.createElement('canvas')
            canvas.width = viewport.width; canvas.height = viewport.height
            await page.render({ canvas, viewport }).promise
            ocrText += (await ocrWorker.recognize(canvas)).data.text + '\n'
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
    let accumulated = ''

    try {
      const res = await fetch('/api/ollama', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ocrText, formatHint: fmt.type }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? 'Ollama request failed')
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try { accumulated += JSON.parse(line).response ?? '' } catch { /* skip */ }
        }
      }
    } catch (e) {
      setError(`Parsing failed: ${String(e)}`); setPhase('idle'); return
    }

    try {
      const clean = accumulated.replace(/```json|```/g, '').trim()
      const start = clean.indexOf('['); const end = clean.lastIndexOf(']')
      if (start === -1 || end === -1) throw new Error('No JSON array found')
      const parsed: Array<{ date: string; description: string; amount: number; category: string }> =
        JSON.parse(clean.slice(start, end + 1))
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

      setDrafts(normalized.map((t) => {
        const rawDesc = t.originalDescription
        const amt = Number(t.amount) || 0
        const match = patterns.length > 0 ? findMatchingRule(patterns, rawDesc, amt) : null
        return {
          _id: crypto.randomUUID(),
          date: t.date ?? today,
          description: match ? match.vendor : rawDesc,
          originalDescription: rawDesc,
          amount: amt,
          transactionType: (match?.transactionType) ?? t.transactionType,
          category: match ? match.category : (t.category ?? ''),
          accountId: selectedAccountId,
          notes: '',
          rawSource: ocrText.slice(0, 2000),
        }
      }))
      setPhase('review')
    } catch (e) {
      setError(`Could not parse model output.\n\n${accumulated.slice(0, 500)}\n\nError: ${String(e)}`)
      setPhase('idle')
    }
  }

  const handleCommit = async () => {
    const res = await fetch('/api/transactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drafts.map(({ _id: _, ...t }) => t)),
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
          <div className="flex items-center gap-3 text-sm" style={{ color: 'var(--tx-secondary)' }}>
            <ThinkingLoader />
            Qwen is thinking…
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
    const S = (SIZE * DPR) / 100

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

    const particleColor = { r: 245, g: 78, b: 0 }

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

      x.beginPath()
      for (let i = 0; i <= 480; i++) {
        const p = pt(i / 480, ds)
        i === 0 ? x.moveTo(p.x * S, p.y * S) : x.lineTo(p.x * S, p.y * S)
      }
      const { r, g, b } = particleColor
      x.strokeStyle = `rgba(${r},${g},${b},0.085)`
      x.lineWidth = 4.6 * S
      x.stroke()

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
