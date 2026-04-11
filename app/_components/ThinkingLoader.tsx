'use client'

import { useEffect, useRef } from 'react'

export function ThinkingLoader() {
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
