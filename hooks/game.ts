// Tandem Arcade: a pixel-art view of the tandem. Claude and Codex are little
// workers who walk between their desks, split in two to spawn helpers, toss
// packets across the hand-off belt, and nap when there is nothing to do.
//
// Everything here is pure: a layout from the pane's size and TANDEM.md, a world
// of actors stepped toward targets each frame, and a pixel canvas drawn from it,
// encoded for the terminal (Raster half-blocks) or the desktop (SVG rects).

import type { ClaudeLive, CodexRun, LiveRun, TandemDoc, Transfer } from '../types'
import { HOLD_MS, TRANSFER_MS, ease } from './anim'

// ── palette ────────────────────────────────────────────────────────────────

const CLEAR = -1
const C = {
  wallL: 0x2a1f1b, wallR: 0x141b2b, trim: 0x3d2c26, trimR: 0x22304a,
  floorL1: 0x31251f, floorL2: 0x2c211c, floorR1: 0x182235, floorR2: 0x151e2f,
  claude: 0xd97757, claudeDark: 0xa8573d, claudeLight: 0xf0a68a, eye: 0x1d120d,
  codexHead: 0xe5e7eb, codexScreen: 0x0b1220, codexEye: 0x22d3ee, codexBody: 0x2563eb, codexDark: 0x1e3a8a, antenna: 0x9ca3af,
  desk: 0x8b5a2b, deskDark: 0x5c3a1a, monitor: 0x374151, screenOff: 0x111827, screenOn: 0x38bdf8, screenOn2: 0x7dd3fc,
  belt: 0x3f3f46, beltStripe: 0x71717a, beltEdge: 0x27272a,
  paper: 0xf8fafc, seal: 0xf59e0b, ok: 0x22c55e, bad: 0xef4444, warn: 0xfacc15,
  poof: 0xd4d4d8, poof2: 0x9ca3af, text: 0xe7e5e4, textDim: 0x78716c, rug: 0x7c2d12, rug2: 0x9a3412, dock: 0x1e293b, dockLight: 0x22d3ee,
  bubble: 0xf5f5f4,
} as const

// ── sprites ────────────────────────────────────────────────────────────────

type Sprite = { w: number; h: number; rows: readonly string[]; pal: Record<string, number> }
const sprite = (pal: Record<string, number>, rows: readonly string[]): Sprite => ({ w: rows[0]!.length, h: rows.length, rows, pal })

const CLAUDE_PAL = { O: C.claude, D: C.claudeDark, L: C.claudeLight, E: C.eye }
const CLAUDE_STAND = sprite(CLAUDE_PAL, ['..LLLL..', '.LOOOOO.', 'OOEOOEOO', 'OOOOOOOO', '.OOOOOO.', '.OOOOOO.', '.D.DD.D.', '.D....D.'])
const CLAUDE_STEP = sprite(CLAUDE_PAL, ['..LLLL..', '.LOOOOO.', 'OOEOOEOO', 'OOOOOOOO', '.OOOOOO.', '.OOOOOO.', '..D..D..', '.D....D.'])
const CLAUDE_TYPE = sprite(CLAUDE_PAL, ['..LLLL..', '.LOOOOO.', 'OOEOOEOO', 'OOOOOOOO', 'DOOOOOOD', '.OOOOOO.', '.D.DD.D.', '.D....D.'])
const CLAUDE_TYPE2 = sprite(CLAUDE_PAL, ['..LLLL..', '.LOOOOO.', 'OOEOOEOO', 'DOOOOOOD', '.OOOOOO.', '.OOOOOO.', '.D.DD.D.', '.D....D.'])
const CLAUDE_NAP = sprite(CLAUDE_PAL, ['........', '..LLLL..', '.LOOOOO.', 'OODOODOO', 'OOOOOOOO', '.OOOOOO.', '.D.DD.D.', '........'])

const CODEX_PAL = { W: C.codexHead, S: C.codexScreen, E: C.codexEye, B: C.codexBody, F: C.codexDark, A: C.antenna }
const CODEX_STAND = sprite(CODEX_PAL, ['...A....', '..WWWW..', '.WSSSSW.', '.WSESEW.', '.WSSSSW.', '..BBBB..', '.BBBBBB.', '.F....F.'])
const CODEX_STEP = sprite(CODEX_PAL, ['...A....', '..WWWW..', '.WSSSSW.', '.WSESEW.', '.WSSSSW.', '..BBBB..', '.BBBBBB.', '..F..F..'])
const CODEX_TYPE = sprite(CODEX_PAL, ['...A....', '..WWWW..', '.WSSSSW.', '.WSESEW.', '.WSSSSW.', 'B.BBBB.B', '.BBBBBB.', '.F....F.'])
const CODEX_TYPE2 = sprite(CODEX_PAL, ['...A....', '..WWWW..', '.WSSSSW.', '.WSESEW.', '.WSSSSW.', '.BBBBBB.', 'B.BBBB.B', '.F....F.'])
const CODEX_NAP = sprite(CODEX_PAL, ['........', '...A....', '..WWWW..', '.WSSSSW.', '.WSFSFW.', '.WSSSSW.', '.BBBBBB.', '.F....F.'])

const PACKET = sprite({ P: C.paper, Y: C.seal }, ['PPPPP', 'PYPYP', 'PPYPP', 'PPPPP'])
const POOF = [
  sprite({ a: C.poof }, ['.......', '...a...', '..a.a..', '...a...', '.......']),
  sprite({ a: C.poof, b: C.poof2 }, ['..a.a..', '.a.b.a.', 'a.b.b.a', '.a.b.a.', '..a.a..']),
  sprite({ a: C.poof2 }, ['.a...a.', 'a.....a', '.......', 'a.....a', '.a...a.']),
]
const WRENCH = sprite({ W: C.antenna }, ['W.W', 'WWW', '.W.', '.W.'])

// 3×5 pixel font, row-major bits.
const FONT: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
  '5': '111100111001111', '6': '111100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001111',
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '-': '000000111000000', '.': '000000000000010', '!': '010010010000010', '?': '110001010000010',
  ' ': '000000000000000', ':': '000010000010000',
}

// ── canvas ─────────────────────────────────────────────────────────────────

export type Canvas = { w: number; h: number; px: Int32Array }

const canvas = (w: number, h: number): Canvas => ({ w, h, px: new Int32Array(w * h).fill(CLEAR) })

const dot = (c: Canvas, x: number, y: number, color: number) => {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (xi >= 0 && yi >= 0 && xi < c.w && yi < c.h) c.px[yi * c.w + xi] = color
}

const fill = (c: Canvas, x: number, y: number, w: number, h: number, color: number) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dot(c, x + i, y + j, color)
}

const draw = (c: Canvas, s: Sprite, x: number, y: number, flip = false) => {
  const x0 = Math.round(x)
  const y0 = Math.round(y)
  for (let j = 0; j < s.h; j++) {
    const row = s.rows[j]!
    for (let i = 0; i < s.w; i++) {
      const ch = row[flip ? s.w - 1 - i : i]!
      const color = s.pal[ch]
      if (color !== undefined) dot(c, x0 + i, y0 + j, color)
    }
  }
}

export const textWidth = (text: string) => Math.max(0, text.length * 4 - 1)

const write = (c: Canvas, text: string, x: number, y: number, color: number) => {
  let cx = Math.round(x)
  for (const ch of text.toUpperCase()) {
    const bits = FONT[ch] ?? FONT['?']!
    for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (bits[j * 3 + i] === '1') dot(c, cx + i, y + j, color)
    cx += 4
  }
}

// ── layout ─────────────────────────────────────────────────────────────────

export type Desk = { part: string; side: 'claude' | 'codex'; x: number; y: number; status: string }
export type Spot = { x: number; y: number }
export type Layout = {
  w: number
  h: number
  wallH: number
  mid: number
  desks: Desk[]
  belt: { x0: number; x1: number; y: number }
  drop: { claude: Spot; codex: Spot }
  home: { claude: Spot; codex: Spot }
  bench: { claude: Spot[]; codex: Spot[] }
}

const DESK_W = 16
const DESK_H = 7
const ACTOR = 8

export const layout = (w: number, h: number, doc: TandemDoc | null): Layout => {
  const wallH = 8
  const mid = Math.floor(w / 2)
  const desks: Desk[] = []
  const zones = { claude: { x0: 2, x1: mid - 3 }, codex: { x0: mid + 3, x1: w - 2 } }
  for (const side of ['claude', 'codex'] as const) {
    const parts = (doc?.parts ?? []).filter(p => (side === 'claude' ? p.lead === 'claude' || p.lead === 'both' : p.lead === 'codex'))
    const zone = zones[side]
    const perRow = Math.max(1, Math.floor((zone.x1 - zone.x0 + 3) / (DESK_W + 3)))
    const rowsFit = h >= 46 ? 2 : 1
    parts.slice(0, perRow * rowsFit).forEach((p, i) => {
      const col = i % perRow
      const row = Math.floor(i / perRow)
      const x = side === 'claude' ? zone.x0 + col * (DESK_W + 3) : zone.x1 - DESK_W - col * (DESK_W + 3)
      desks.push({ part: p.id, side, x, y: wallH + 2 + row * 16, status: p.status })
    })
  }
  const beltY = h - 4
  const halfBelt = Math.max(8, Math.floor(w * 0.16))
  const belt = { x0: mid - halfBelt, x1: mid + halfBelt, y: beltY }
  const floorY = h - ACTOR - 1
  const benchY = Math.min(floorY, wallH + DESK_H + 12)
  const bench = (side: 'claude' | 'codex') =>
    Array.from({ length: 6 }, (_, i) => ({ x: side === 'claude' ? 3 + i * 10 : w - 11 - i * 10, y: benchY - (i % 2) * 2 }))
  return {
    w,
    h,
    wallH,
    mid,
    desks,
    belt,
    drop: { claude: { x: belt.x0 - ACTOR - 1, y: beltY - ACTOR + 1 }, codex: { x: belt.x1 + 1, y: beltY - ACTOR + 1 } },
    home: { claude: { x: 3, y: floorY }, codex: { x: w - ACTOR - 3, y: floorY } },
    bench: { claude: bench('claude'), codex: bench('codex') },
  }
}

const deskSpot = (d: Desk): Spot => ({ x: d.x + 6, y: d.y + DESK_H - 1 })

// ── world ──────────────────────────────────────────────────────────────────

export type Actor = {
  id: string
  kind: 'claude' | 'codex'
  isClone: boolean
  x: number
  y: number
  tx: number
  ty: number
  bornAt: number
  leavingAt?: number
  flip: boolean
  walked: number
  activity: 'idle' | 'walk' | 'work' | 'think' | 'tool' | 'nap' | 'toss'
  carry: boolean
}

export type Poof = { x: number; y: number; at: number }
export type World = { actors: Map<string, Actor>; poofs: Poof[]; t: number }

export const newWorld = (): World => ({ actors: new Map(), poofs: [], t: 0 })

export type Inputs = {
  doc: TandemDoc | null
  claude: ClaudeLive
  runs: readonly LiveRun[]
  codex: readonly CodexRun[]
  transfers: readonly Transfer[]
}

const SPEED = 26 // px per second

const spawn = (world: World, id: string, kind: Actor['kind'], from: Spot, t: number, isClone: boolean): Actor => {
  const a: Actor = { id, kind, isClone, x: from.x, y: from.y, tx: from.x, ty: from.y, bornAt: t, flip: kind === 'codex', walked: 0, activity: 'idle', carry: false }
  world.actors.set(id, a)
  if (isClone) world.poofs.push({ x: from.x, y: from.y, at: t })
  return a
}

/** Decides where everyone should be, then walks them there by `dt` seconds. */
export const step = (world: World, lay: Layout, inp: Inputs, t: number) => {
  const dt = world.t === 0 ? 0 : Math.min(0.25, Math.max(0, (t - world.t) / 1000))
  world.t = t
  const deskFor = (part: string | undefined, side: 'claude' | 'codex') =>
    lay.desks.find(d => d.part === part) ?? lay.desks.find(d => d.side === side && d.status !== 'accepted') ?? lay.desks.find(d => d.side === side)

  // Claude, the original.
  const claude = world.actors.get('claude') ?? spawn(world, 'claude', 'claude', lay.home.claude, t, false)
  const cl = inp.claude
  const claudeDesk = deskFor(undefined, 'claude')
  const working = cl.mode !== 'idle'
  const toss = inp.transfers.find(x => x.dir === 'to-codex' && t >= x.startAt - 900 && t < x.startAt + TRANSFER_MS * 0.35)
  const target = toss ? lay.drop.claude : working && claudeDesk ? deskSpot(claudeDesk) : lay.home.claude
  claude.tx = target.x
  claude.ty = target.y
  claude.carry = toss !== undefined && t < toss.startAt
  claude.activity = toss ? 'toss' : cl.mode === 'thinking' ? 'think' : cl.mode === 'tool' ? 'tool' : working ? 'work' : 'nap'

  // Claude's helpers: one clone per running subagent or headless claude.
  const helpers = inp.runs.filter(r => r.side === 'claude')
  helpers.forEach((r, i) => {
    const id = `claude:${r.id}`
    const a = world.actors.get(id) ?? (r.endedAt === undefined ? spawn(world, id, 'claude', { x: claude.x, y: claude.y }, t, true) : undefined)
    if (a === undefined) return
    if (r.endedAt !== undefined) {
      a.leavingAt ??= t
      a.tx = claude.x
      a.ty = claude.y
      a.activity = 'walk'
    } else {
      const spot = lay.bench.claude[i % lay.bench.claude.length]!
      a.tx = spot.x
      a.ty = spot.y
      a.activity = 'work'
    }
  })

  // Codex: the original takes the first active run; each further run is a clone.
  const active = inp.codex.filter(r => r.endedAt === undefined)
  const codex = world.actors.get('codex') ?? spawn(world, 'codex', 'codex', lay.home.codex, t, false)
  const back = inp.transfers.find(x => x.dir === 'to-claude' && t >= x.startAt - 900 && t < x.startAt + TRANSFER_MS * 0.35)
  const catching = inp.transfers.find(x => x.dir === 'to-codex' && t >= x.startAt + TRANSFER_MS * 0.4 && t < x.startAt + TRANSFER_MS + HOLD_MS)
  const first = active[0]
  const codexDesk = first ? deskFor(first.part, 'codex') : undefined
  const codexTarget = back ? lay.drop.codex : catching ? lay.drop.codex : first && codexDesk ? deskSpot(codexDesk) : lay.home.codex
  codex.tx = codexTarget.x
  codex.ty = codexTarget.y
  codex.carry = back !== undefined && t < back.startAt
  const quiet = first !== undefined && t - first.lastEventAt > 2500
  codex.activity = back ? 'toss' : first === undefined ? 'nap' : quiet ? 'think' : 'work'
  active.slice(1).forEach((r, i) => {
    const id = `codex:${r.id}`
    const a = world.actors.get(id) ?? spawn(world, id, 'codex', { x: codex.x, y: codex.y }, t, true)
    const desk = deskFor(r.part, 'codex')
    const spot = desk && desk !== codexDesk ? deskSpot(desk) : lay.bench.codex[i % lay.bench.codex.length]!
    a.tx = spot.x
    a.ty = spot.y
    a.activity = t - r.lastEventAt > 2500 ? 'think' : 'work'
  })
  for (const a of world.actors.values()) {
    // A clone whose run finished, or whose run became the original's (the first active), goes home.
    if (a.kind === 'codex' && a.isClone && !active.slice(1).some(r => `codex:${r.id}` === a.id)) {
      a.leavingAt ??= t
      a.tx = codex.x
      a.ty = codex.y
    }
    if (a.kind === 'claude' && a.isClone && !helpers.some(r => `claude:${r.id}` === a.id)) {
      a.leavingAt ??= t
      a.tx = claude.x
      a.ty = claude.y
    }
  }

  // Walk.
  for (const a of world.actors.values()) {
    const dx = a.tx - a.x
    const dy = a.ty - a.y
    const dist = Math.hypot(dx, dy)
    const reach = SPEED * dt * (a.isClone ? 1.3 : 1)
    if (dist > 0.4) {
      const k = Math.min(1, reach / dist)
      a.x += dx * k
      a.y += dy * k
      a.walked += reach
      if (Math.abs(dx) > 0.4) a.flip = dx < 0
    } else {
      a.x = a.tx
      a.y = a.ty
    }
    // A clone that has walked home (or given up after 4s) merges back in a puff.
    if (a.leavingAt !== undefined && (dist <= 1 || t - a.leavingAt > 4000)) {
      world.poofs.push({ x: a.x, y: a.y, at: t })
      world.actors.delete(a.id)
    }
  }
  world.poofs = world.poofs.filter(p => t - p.at < 600)
}

const isMoving = (a: Actor) => Math.hypot(a.tx - a.x, a.ty - a.y) > 0.4

// ── drawing ────────────────────────────────────────────────────────────────

export const render = (world: World, lay: Layout, inp: Inputs, t: number): Canvas => {
  const c = canvas(lay.w, lay.h)
  const { w, h, wallH, mid } = lay

  // Room: two halves, warm and cool, tiled floors, a wall with name plates.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const left = x < mid
      const color =
        y < wallH ? (left ? C.wallL : C.wallR)
        : y === wallH ? (left ? C.trim : C.trimR)
        : ((x >> 2) + (y >> 2)) % 2 === 0 ? (left ? C.floorL1 : C.floorR1) : left ? C.floorL2 : C.floorR2
      c.px[y * w + x] = color
    }
  }
  for (let y = wallH + 1; y < h; y += 2) dot(c, mid, y, C.beltEdge)
  write(c, 'CLAUDE', 2, 1, C.claude)
  write(c, 'CODEX', w - textWidth('CODEX') - 2, 1, C.codexEye)

  // Rug for Claude's naps; charging dock for Codex.
  fill(c, lay.home.claude.x - 1, lay.home.claude.y + ACTOR - 2, ACTOR + 2, 2, C.rug)
  fill(c, lay.home.claude.x, lay.home.claude.y + ACTOR - 2, ACTOR, 1, C.rug2)
  fill(c, lay.home.codex.x - 1, lay.home.codex.y + ACTOR - 1, ACTOR + 2, 1, C.dock)
  if (Math.floor(t / 600) % 2 === 0) dot(c, lay.home.codex.x + ACTOR, lay.home.codex.y + ACTOR - 1, C.dockLight)

  // Desks: part id on the front, a monitor that glows while someone works at it.
  for (const d of lay.desks) {
    const atDesk = [...world.actors.values()].some(
      a => !isMoving(a) && Math.abs(a.x - (d.x + 6)) < 1 && Math.abs(a.y - (d.y + DESK_H - 1)) < 1 && (a.activity === 'work' || a.activity === 'think' || a.activity === 'tool'),
    )
    fill(c, d.x + 7, d.y, 8, 5, C.monitor)
    const screen = d.status === 'accepted' ? C.ok : d.status === 'blocked' ? C.bad : atDesk ? (Math.floor(t / 180) % 3 === 0 ? C.screenOn2 : C.screenOn) : C.screenOff
    fill(c, d.x + 8, d.y + 1, 6, 3, screen)
    if (atDesk && d.status !== 'accepted') {
      const line = Math.floor(t / 120) % 3
      fill(c, d.x + 8, d.y + 1 + line, 2 + ((t >> 7) % 4), 1, C.paper)
    }
    if (d.status === 'accepted') {
      dot(c, d.x + 9, d.y + 2, C.paper)
      dot(c, d.x + 10, d.y + 3, C.paper)
      dot(c, d.x + 11, d.y + 2, C.paper)
      dot(c, d.x + 12, d.y + 1, C.paper)
    }
    fill(c, d.x + 10, d.y + 5, 2, 1, C.monitor)
    fill(c, d.x, d.y + 6, DESK_W, 1, C.desk)
    fill(c, d.x + 1, d.y + 7, 1, 2, C.deskDark)
    fill(c, d.x + DESK_W - 2, d.y + 7, 1, 2, C.deskDark)
    write(c, d.part.slice(0, 2), d.x, d.y, d.side === 'claude' ? C.claudeLight : C.codexEye)
  }

  // The hand-off belt, its stripes rolling toward whichever side is receiving.
  const { x0, x1, y: by } = lay.belt
  const rolling = inp.transfers.find(x => t >= x.startAt && t < x.startAt + TRANSFER_MS)
  const shift = rolling ? (rolling.dir === 'to-codex' ? 1 : -1) * Math.floor(t / 70) : 0
  fill(c, x0, by - 1, x1 - x0, 1, C.beltEdge)
  fill(c, x0, by, x1 - x0, 2, C.belt)
  for (let x = x0; x < x1; x++) if ((((x - shift) % 4) + 4) % 4 === 0) fill(c, x, by, 1, 2, C.beltStripe)
  fill(c, x0, by + 2, x1 - x0, 1, C.beltEdge)

  // Packets riding the belt.
  for (const tr of inp.transfers) {
    const p = (t - tr.startAt) / TRANSFER_MS
    if (p < 0 || p > 1) continue
    const k = ease(p)
    const span = x1 - x0 - PACKET.w
    const px = tr.dir === 'to-codex' ? x0 + k * span : x1 - PACKET.w - k * span
    draw(c, PACKET, px, by - PACKET.h - Math.round(Math.sin(p * Math.PI * 6) * 0.6))
  }

  // Actors, back to front.
  const actors = [...world.actors.values()].sort((a, b) => a.y - b.y)
  for (const a of actors) {
    const moving = isMoving(a)
    const stepFrame = Math.floor(a.walked / 2.5) % 2 === 1
    const typing = Math.floor(t / 160) % 2 === 1
    const bob = !moving && (a.activity === 'think' || a.activity === 'nap') ? (Math.floor(t / 500) % 2) : 0
    const s =
      a.kind === 'claude'
        ? moving ? (stepFrame ? CLAUDE_STEP : CLAUDE_STAND) : a.activity === 'nap' ? CLAUDE_NAP : a.activity === 'work' || a.activity === 'tool' ? (typing ? CLAUDE_TYPE : CLAUDE_TYPE2) : CLAUDE_STAND
        : moving ? (stepFrame ? CODEX_STEP : CODEX_STAND) : a.activity === 'nap' ? CODEX_NAP : a.activity === 'work' ? (typing ? CODEX_TYPE : CODEX_TYPE2) : CODEX_STAND
    const born = t - a.bornAt
    if (a.isClone && born < 300) continue // still inside the puff
    draw(c, s, a.x, a.y + bob, a.flip)
    if (a.kind === 'codex' && Math.floor(t / 400) % 2 === 0) dot(c, a.x + (a.flip ? 4 : 3), a.y + bob - 1, C.codexEye)
    if (a.carry) draw(c, PACKET, a.x + 1, a.y - PACKET.h - 1)

    // Bubbles beside the head (above it would sit on the monitor).
    const hx = a.flip ? a.x - 7 : a.x + 9
    const hy = a.y
    if (!moving && a.activity === 'think') {
      const n = Math.floor(t / 300) % 4
      fill(c, hx - 1, hy - 1, 7, 3, C.bubble)
      for (let i = 0; i < Math.min(3, n); i++) dot(c, hx + i * 2, hy, C.eye)
    } else if (!moving && a.activity === 'tool') {
      draw(c, WRENCH, hx + 1, hy)
    } else if (!moving && a.activity === 'nap') {
      const z = Math.floor(t / 450) % 3
      write(c, 'Z', a.x + 6 + z, a.y - 5 - z, C.textDim)
    }
  }

  // Arrivals: a "!" over whoever just caught a packet.
  for (const tr of inp.transfers) {
    const since = t - (tr.startAt + TRANSFER_MS)
    if (since < 0 || since > HOLD_MS) continue
    const who = world.actors.get(tr.dir === 'to-codex' ? 'codex' : 'claude')
    if (who) write(c, '!', who.x + 3, who.y - 7, tr.isError ? C.bad : C.warn)
  }

  // Splits and merges.
  for (const p of world.poofs) {
    const f = Math.min(POOF.length - 1, Math.floor((t - p.at) / 200))
    draw(c, POOF[f]!, p.x, p.y + 1)
  }
  return c
}

// ── encoders ───────────────────────────────────────────────────────────────

const toBase64 = (bytes: Uint8Array): string => {
  const fast = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof fast === 'function') return fast.call(bytes)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Terminal: one cell per two pixels, `▀` drawn in the top pixel over the bottom one. */
export const toRasterCells = (c: Canvas): { columns: number; rows: number; cells: string } => {
  const rows = Math.floor(c.h / 2)
  const words = new Uint32Array(c.w * rows * 3)
  const bg = 0x0c0a09
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < c.w; x++) {
      const top = c.px[r * 2 * c.w + x]!
      const bottom = c.px[(r * 2 + 1) * c.w + x]!
      const k = (r * c.w + x) * 3
      words[k] = 0x2580
      words[k + 1] = top === CLEAR ? bg : top
      words[k + 2] = bottom === CLEAR ? bg : bottom
    }
  }
  return { columns: c.w, rows, cells: toBase64(new Uint8Array(words.buffer)) }
}

/** The most an Svg source may hold (SvgProps.source). */
export const SVG_LIMIT = 131_072

/**
 * Desktop: the same pixels as SVG, one path per color, each run of that color
 * along a row a `M x y h n v1 h-n z` box. Several times smaller than a rect per
 * run; the caller still checks the result against SVG_LIMIT.
 */
export const toSvg = (c: Canvas): string => {
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
  const byColor = new Map<number, string[]>()
  for (let y = 0; y < c.h; y++) {
    let x = 0
    while (x < c.w) {
      const color = c.px[y * c.w + x]!
      let run = 1
      while (x + run < c.w && c.px[y * c.w + x + run] === color) run++
      if (color !== CLEAR) {
        const d = byColor.get(color) ?? []
        d.push(`M${x} ${y}h${run}v1h-${run}z`)
        byColor.set(color, d)
      }
      x += run
    }
  }
  const paths = [...byColor].map(([color, d]) => `<path fill="${hex(color)}" d="${d.join('')}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.w} ${c.h}" shape-rendering="crispEdges">${paths.join('')}</svg>`
}
