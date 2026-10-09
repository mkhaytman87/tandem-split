import type { Transfer } from '../types'

/** How long a packet takes to cross, and how long it rests at its end. */
export const TRANSFER_MS = 1600
export const HOLD_MS = 1200
export const FLASH_MS = 5000

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const STAR = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const PULSE = ['◐', '◓', '◑', '◒']

export const spin = (now: number) => SPIN[Math.floor(now / 90) % SPIN.length]!
export const star = (now: number) => STAR[Math.floor(now / 120) % STAR.length]!
export const pulse = (now: number) => PULSE[Math.floor(now / 180) % PULSE.length]!

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** When a new packet may leave: after the one ahead of it has crossed. */
export const nextSlot = (transfers: readonly Transfer[], now: number) => {
  const last = transfers.at(-1)
  return Math.max(now, last ? last.startAt + TRANSFER_MS + 250 : now)
}

/** The packet to draw: one still crossing wins over one resting at its end. */
export const activeTransfer = (transfers: readonly Transfer[], now: number) =>
  transfers.find(t => now >= t.startAt && now < t.startAt + TRANSFER_MS) ??
  [...transfers].reverse().find(t => now >= t.startAt && now < t.startAt + TRANSFER_MS + HOLD_MS)

export const queuedCount = (transfers: readonly Transfer[], now: number) => transfers.filter(t => t.startAt > now).length

/** The packet that most recently landed on a side, while its arrival still flashes. */
export const arrivalOn = (transfers: readonly Transfer[], side: 'claude' | 'codex', now: number) =>
  transfers.find(t => {
    const landed = t.startAt + TRANSFER_MS
    return t.dir === (side === 'codex' ? 'to-codex' : 'to-claude') && now >= landed && now < landed + HOLD_MS + 600
  })

export const isAnimating = (transfers: readonly Transfer[], now: number) =>
  transfers.some(t => now < t.startAt + TRANSFER_MS + HOLD_MS + 600)

export type WireSegment = { text: string; style: 'track' | 'trail' | 'packet' }

/**
 * One frame of a packet crossing a track `width` cells wide: the track before
 * it, its trail, the packet, the track after. Undefined when no packet moves.
 */
export const wireFrame = (width: number, t: Transfer | undefined, now: number): WireSegment[] | undefined => {
  if (t === undefined || width < 8) return undefined
  const arrow = t.dir === 'to-codex' ? '▶' : '◀'
  const room = Math.max(1, width - 6)
  const label = t.label.length > room ? `${t.label.slice(0, room - 1)}…` : t.label
  const packet = `${arrow} ${label} ${arrow}`
  const span = Math.max(0, width - packet.length)
  const p = ease(Math.min(1, Math.max(0, (now - t.startAt) / TRANSFER_MS)))
  const x = Math.round((t.dir === 'to-codex' ? p : 1 - p) * span)
  const line = (n: number) => '─'.repeat(Math.max(0, n))
  const glow = (n: number) => '━'.repeat(Math.max(0, n))
  const arrived = p >= 1
  if (t.dir === 'to-codex') {
    const trail = arrived ? 0 : Math.min(4, x)
    return [
      { text: line(x - trail), style: 'track' },
      { text: glow(trail), style: 'trail' },
      { text: packet, style: 'packet' },
      { text: line(span - x), style: 'track' },
    ]
  }
  const after = span - x
  const trail = arrived ? 0 : Math.min(4, after)
  return [
    { text: line(x), style: 'track' },
    { text: packet, style: 'packet' },
    { text: glow(trail), style: 'trail' },
    { text: line(after - trail), style: 'track' },
  ]
}

/** Typewriter: how much of `text` shows `now`, `since` being when it arrived. */
export const reveal = (text: string, since: number | undefined, now: number, cps = 110) => {
  if (since === undefined) return text
  const n = Math.floor(((now - since) * cps) / 1000)
  return n >= text.length ? text : text.slice(0, Math.max(1, n))
}

export const isTyping = (text: string | undefined, since: number | undefined, now: number, cps = 110) =>
  text !== undefined && since !== undefined && ((now - since) * cps) / 1000 < text.length
