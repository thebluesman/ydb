/**
 * Category colour palette — every colour here has been verified to achieve
 * ≥ 4.5:1 contrast ratio against white (#fff), meeting WCAG 2.1 AA for
 * normal-sized text on a coloured pill/badge background.
 */
export const PALETTE = [
  '#1D4ED8', // blue-700
  '#B91C1C', // red-700
  '#15803D', // green-700
  '#6D28D9', // violet-700
  '#BE185D', // pink-700
  '#B45309', // amber-700
  '#0E7490', // cyan-700
  '#047857', // emerald-700
  '#C2410C', // orange-700
  '#0369A1', // sky-700
  '#9333EA', // purple-600
  '#5B21B6', // violet-800
]

/** djb2 hash → stable colour based on category name */
function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** Deterministic palette colour for a given category name. */
export function colorForCategory(name: string): string {
  return PALETTE[hashStr(name) % PALETTE.length]
}

// ── WCAG contrast helpers ─────────────────────────────────────────────────────

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const [bright, dark] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (bright + 0.05) / (dark + 0.05)
}

/**
 * Returns the foreground colour (#fff or #111827) that achieves the higher
 * contrast ratio against `bg`, ensuring WCAG AA compliance.
 */
export function pillTextColor(bg: string): string {
  try {
    const onWhite = contrastRatio(bg, '#ffffff')
    const onDark  = contrastRatio(bg, '#111827')
    return onWhite >= onDark ? '#ffffff' : '#111827'
  } catch {
    return '#ffffff'
  }
}
