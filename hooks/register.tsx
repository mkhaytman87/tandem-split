import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ClaudeLive, CodexRun, LiveRun, PartChange, PartStatus, Side, TandemDoc, TandemPart, Transfer } from '../types'
import {
  FLASH_MS,
  HOLD_MS,
  TRANSFER_MS,
  activeTransfer,
  arrivalOn,
  isTyping,
  nextSlot,
  pulse,
  queuedCount,
  reveal,
  spin,
  star,
  wireFrame,
} from './anim'
import { SVG_LIMIT, layout, newWorld, render as renderArcade, step as stepArcade, toRasterCells, toSvg } from './game'
import type { Canvas, Inputs, World } from './game'
import { claudeRun, codexRun, dirRelation, firstLine, notificationOutcomes, parseRollout, parseTandem, salvageLine, workflow } from './parse'
import type { RolloutView } from './parse'

const PANE = 'tandem'
const ARCADE = 'tandem-arcade'
const TITLE = 'Tandem'
const ARCADE_TITLE = 'Tandem Arcade'
const IDLE: ClaudeLive = { mode: 'idle', text: '', since: 0 }

const file = atom({ plugin: 'tandem-split', key: 'file' } as const, null)
const doc = atom({ plugin: 'tandem-split', key: 'doc' } as const, null)
const runs = atom({ plugin: 'tandem-split', key: 'runs' } as const, [])
const codex = atom({ plugin: 'tandem-split', key: 'codex' } as const, [])
const transfers = atom({ plugin: 'tandem-split', key: 'transfers' } as const, [])
const claude = atom({ plugin: 'tandem-split', key: 'claude' } as const, IDLE)
const changes = atom({ plugin: 'tandem-split', key: 'changes' } as const, [])
const now = atom({ plugin: 'tandem-split', key: 'now' } as const, 0)
const arcadeTick = atom({ plugin: 'tandem-split', key: 'arcade' } as const, 0)

const GLYPH: Record<PartStatus, string> = {
  assigned: '○',
  'handed-off': '→',
  delivered: '◆',
  'in-review': '◐',
  accepted: '✓',
  blocked: '✗',
}

const isTandem = (path: unknown): boolean => typeof path === 'string' && /(^|\/)TANDEM\.md$/.test(path)
const dirOf = (path: string) => path.replace(/\/[^/]*$/, '')
const short = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')
const clip = (text: string, max: number) => {
  const flat = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}
const looksLikePath = (arg: string) => !/\s/.test(arg) || /^[~/.]/.test(arg)
const byteLength = (s: string) => new TextEncoder().encode(s).length

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

// ── Module-held live state (rebuilt on reload; what the panes draw lives in $.state) ──

/** Claude's response stream, buffered per chunk and flushed on the animation frame. */
const stream = { live: { ...IDLE } as ClaudeLive, index: -1, input: '', isDirty: false }

/** One rollout log read so far: how far, what it said, and whether it is ours. */
type Rollout = { offset: number; mtimeMs: number; view: RolloutView; isOurs?: boolean; lineStarts?: boolean }
const rollouts = new Map<string, Rollout>()
/** Logs that belong to another folder, and old logs skipped by age (at the mtime they had). */
const foreign = new Set<string>()
const aged = new Map<string, number>()
const canonical = new Map<string, string>()
/** Packets already sent, so a re-read never sends one twice. */
const sentKeys = new Set<string>()
/** Bumped on every retarget: a poll that started for an older TANDEM.md commits nothing. */
let targetGen = 0
/** Task notifications seen, by id: one can arrive before its run has recorded the id it waits on. */
const notified = new Map<string, { isError: boolean; at: number }>()

const openPanes = new Set<string>()
let hasDoc = false
let loadedAt = Date.now()
let anim: Timer | undefined
let isFraming = false
let isPolling = false
let ticks = 0
/** The engine-clock time until which something is still moving (packets, flashes, typing). */
let busyUntil = 0
/** Codex runs and Claude helpers in flight, and background runs awaiting a notification. */
let activeCount = 0

/** Tandem work is on when a TANDEM.md is loaded or one of its panes is open; otherwise nothing runs. */
const isTandemActive = () => hasDoc || openPanes.size > 0

/** The engine's clock, which frames run on; the wall clock where none answers. */
const clockNow = ($: EngineInterface) => $.clock.now().catch(() => Date.now())

async function homeDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home) return home.replace(/\/+$/, '')
  return (await $.session.cwd()).match(/^\/Users\/[^/]+/)?.[0]
}

async function canon($: EngineInterface, path: string): Promise<string> {
  const plain = path.replace(/^file:\/\//, '').replace(/\/+$/, '')
  const hit = canonical.get(plain)
  if (hit !== undefined) return hit
  const real = await $.fs
    .stat(plain, { resolve: true })
    .then(s => s.realPath ?? plain)
    .catch(() => plain)
  canonical.set(plain, real)
  return real
}

function openPane($: EngineInterface, id: string, title: string) {
  openPanes.add(id)
  void $.ui.open({ id, title }).catch(() => undefined)
}

// ── TANDEM.md ──────────────────────────────────────────────────────────────

/** Loads run one at a time: two interleaved loads could leave the path and the document disagreeing. */
let loadQueue: Promise<unknown> = Promise.resolve()
const serially = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = loadQueue.then(fn, fn)
  loadQueue = run.catch(() => undefined)
  return run
}

const load = ($: EngineInterface, path: string): Promise<boolean> => serially(() => loadNow($, path))

/** Re-reads `path` only if it is still the TANDEM.md shown once its turn comes. */
const reloadIfCurrent = ($: EngineInterface, path: string): Promise<boolean> =>
  serially(async () => ((await read($, file)) === path ? loadNow($, path) : false))

async function loadNow($: EngineInterface, path: string): Promise<boolean> {
  try {
    const stat = await $.fs.stat(path)
    const text = await $.fs.read(path)
    const before = await read($, doc)
    const samePath = (await read($, file)) === path
    const next = parseTandem(String(text), stat.mtimeMs)
    // The path first, then the generation: a poll reading the generation and then the path can never
    // pair the new generation with the old path (it may pair the old one with the new, which it then voids).
    await update($, file, () => path)
    if (!samePath) await retarget($)
    await update($, doc, () => next)
    hasDoc = true
    await $.store.set('lastFile', path)
    if (samePath && before !== null) await noteChanges($, before, next)
    return true
  } catch {
    return false
  }
}

/** A new TANDEM.md: Codex runs, packets and flashes of the old one do not carry over. */
async function retarget($: EngineInterface) {
  targetGen += 1
  rollouts.clear()
  foreign.clear()
  aged.clear()
  sentKeys.clear()
  await update($, codex, () => [])
  await update($, transfers, () => [])
  await update($, changes, () => [])
}

/** New parts and status moves since the last read flash in the lanes. */
async function noteChanges($: EngineInterface, before: TandemDoc, after: TandemDoc) {
  const t = await clockNow($)
  const found: PartChange[] = []
  for (const part of after.parts) {
    const old = before.parts.find(p => p.id === part.id)
    if (old === undefined) found.push({ id: part.id, kind: 'new', at: t })
    else if (old.status !== part.status) found.push({ id: part.id, kind: 'status', from: old.status, to: part.status, at: t })
  }
  if (found.length === 0) return
  await update($, changes, list => [...list.filter(c => t - c.at < FLASH_MS && !found.some(f => f.id === c.id)), ...found])
  busyUntil = Math.max(busyUntil, t + FLASH_MS)
  startAnim($)
}

async function resolveTarget($: EngineInterface, arg: string): Promise<string> {
  const cwd = await $.session.cwd()
  const home = await homeDir($)
  const expanded = arg.startsWith('~/') && home ? `${home}${arg.slice(1)}` : arg
  const path = expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`.replace(/\/\.\//g, '/')
  return isTandem(path) ? path : `${path.replace(/\/$/, '')}/TANDEM.md`
}

/** The project's own TANDEM.md (root, then cwd). */
async function discoverHere($: EngineInterface): Promise<boolean> {
  const roots = [await $.session.root(), await $.session.cwd()]
  for (const root of roots) {
    if (await load($, `${root.replace(/\/$/, '')}/TANDEM.md`)) return true
  }
  return false
}

/** Asked for by the person: the project's TANDEM.md, else the last one they looked at. */
async function discover($: EngineInterface): Promise<void> {
  if (await discoverHere($)) return
  const last = await $.store.get('lastFile')
  if (typeof last === 'string') await load($, last)
}

// ── Packets between the lanes ─────────────────────────────────────────────

async function send($: EngineInterface, key: string, dir: Transfer['dir'], label: string, isError?: boolean) {
  if (sentKeys.has(key)) return
  sentKeys.add(key)
  const t = await clockNow($)
  let startAt = t
  await update($, transfers, list => {
    const live = list.filter(x => t < x.startAt + TRANSFER_MS + 4000)
    startAt = nextSlot(live, t)
    return [...live, { id: `${dir}-${t}-${live.length}`, dir, label, startAt, isError }].slice(-12)
  })
  busyUntil = Math.max(busyUntil, startAt + TRANSFER_MS + HOLD_MS + 600)
  startAnim($)
}

// ── Codex: rollout logs ─────────────────────────────────────────────────────

const dayFolder = (home: string, d: Date) =>
  `${home}/.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`

const SMALL_BYTES = 1024 * 1024
/** Under the 4 MiB the process noun returns, with room for a long last line. */
const CHUNK_BYTES = 3 * 1024 * 1024
const CHUNKS_PER_POLL = 4

/** `length` bytes of `path` from byte `from`: the path and numbers are arguments, never shell text. */
const readBytes = async ($: EngineInterface, path: string, from: number, length: number) =>
  (await $.process.run(['/bin/sh', '-c', 'tail -c +"$1" "$2" | head -c "$3"', 'sh', String(from + 1), path, String(length)])).stdout

/**
 * Reads a rollout in order, a few chunks a poll, folding each into the view so
 * far, so the hand-off, every file written and the completion are all seen
 * however large the log. A partial last line waits for the next read; the
 * caller reads again while `offset` is short of the size, changed mtime or not.
 */
async function readRollout($: EngineInterface, path: string, size: number, cached: Rollout | undefined): Promise<Rollout> {
  let offset = cached?.offset ?? 0
  let view = cached?.view
  if (size < offset) {
    // Truncated or replaced: start over.
    offset = 0
    view = undefined
  }
  // Whether this read starts at a line's start (false while stepping through a giant line).
  let lineStarts = cached?.lineStarts ?? true
  for (let n = 0; n < CHUNKS_PER_POLL && offset < size; n++) {
    const text = offset === 0 && size <= SMALL_BYTES ? String(await $.fs.read(path)) : await readBytes($, path, offset, CHUNK_BYTES)
    if (text === '') break
    const end = text.lastIndexOf('\n')
    if (end < 0) {
      // A single line longer than a chunk (a file change carrying its whole content): keep what its
      // start tells (the paths written), then step past it rather than stall on it.
      // Short of a whole chunk: the file's end (the line is still being written). A chunk cut inside a
      // multi-byte character decodes a little longer or shorter, hence the slack.
      if (byteLength(text) < CHUNK_BYTES - 8) break
      if (lineStarts) view = salvageLine(view ?? parseRollout(''), text)
      offset += CHUNK_BYTES
      lineStarts = false
      continue
    }
    lineStarts = true
    const complete = text.slice(0, end + 1)
    view = parseRollout(complete, view)
    offset += byteLength(complete)
  }
  return { offset, mtimeMs: cached?.mtimeMs ?? 0, view: view ?? parseRollout(''), isOurs: cached?.isOurs, lineStarts }
}

async function isOurs($: EngineInterface, view: RolloutView, dir: string): Promise<boolean | undefined> {
  if (view.cwd === undefined) return undefined
  const cwd = await canon($, view.cwd)
  const target = await canon($, dir)
  const relation = dirRelation(cwd, target)
  if (relation === 'same' || relation === 'inside') return true
  // A session at a folder above the tandem folder counts only at a repo root.
  if (relation === 'above') return $.fs.exists(`${cwd}/.git`).catch(() => false)
  return false
}

/** `gen` is the target generation read together with `dir`: a switch since then voids this poll. */
async function pollCodex($: EngineInterface, dir: string, gen: number): Promise<void> {
  if (gen !== targetGen) return
  const home = await homeDir($)
  if (home === undefined) return
  const t = Date.now()
  const listed = new Map<string, { size: number; mtimeMs: number }>()
  // Today and yesterday every poll; the week before every tenth (an old session resumed in place).
  const days = ticks % 10 === 0 ? [0, 1, 2, 3, 4, 5, 6] : [0, 1]
  for (const back of days) {
    const folder = dayFolder(home, new Date(t - back * 86_400_000))
    for (const entry of await $.fs.list(folder).catch(() => [])) {
      if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) listed.set(`${folder}/${entry.name}`, entry)
    }
  }
  // Logs already followed keep being watched by path, wherever they live.
  for (const f of rollouts.keys()) {
    if (listed.has(f)) continue
    const stat = await $.fs.stat(f).catch(() => undefined)
    if (stat) listed.set(f, stat)
  }
  if (gen !== targetGen) return
  for (const [f, entry] of listed) {
    if (foreign.has(f)) continue
    const cached = rollouts.get(f)
    // Unchanged and fully read: nothing to do. Short of its size: keep draining, mtime or not.
    if (cached !== undefined && cached.mtimeMs === entry.mtimeMs && cached.offset >= entry.size) continue
    if (cached === undefined) {
      // Old and quiet: skip for now, but look again if it ever changes.
      if (entry.mtimeMs < loadedAt - 10 * 60_000 && aged.get(f) !== entry.mtimeMs) {
        if (!aged.has(f)) {
          aged.set(f, entry.mtimeMs)
          continue
        }
      } else if (aged.get(f) === entry.mtimeMs) {
        continue
      }
    }
    if (cached === undefined) {
      // A log new to us: decide from its first 64 KB (the session's folder is its first line) before
      // reading any more of it.
      const head = await readBytes($, f, 0, 64 * 1024).catch(() => '')
      const meta = parseRollout(head.slice(0, head.lastIndexOf('\n') + 1))
      const ours = await isOurs($, meta, dir)
      if (gen !== targetGen) return
      if (ours === false) {
        foreign.add(f)
        continue
      }
      if (ours === undefined) continue // no session line yet: look again next poll
    }
    const next = await readRollout($, f, entry.size, cached).catch(() => undefined)
    if (next === undefined || gen !== targetGen) continue
    next.mtimeMs = entry.mtimeMs
    next.isOurs ??= await isOurs($, next.view, dir)
    if (gen !== targetGen) return
    if (next.isOurs === false) {
      foreign.add(f)
      rollouts.delete(f)
      continue
    }
    rollouts.set(f, next)
    if (next.isOurs) await applyRollout($, f, next.view, entry.mtimeMs, gen)
  }
  if (gen !== targetGen) return
  // A session that has written nothing for 15 minutes has gone quiet; one that never got past starting, after 2.
  await update($, codex, list =>
    list.map(r => {
      const limit = r.commentary === undefined && r.activity === undefined ? 2 * 60_000 : 15 * 60_000
      return r.endedAt === undefined && t - r.mtimeMs > limit ? { ...r, endedAt: r.mtimeMs, isStalled: true } : r
    }),
  )
}

async function applyRollout($: EngineInterface, f: string, view: RolloutView, mtimeMs: number, gen: number) {
  const t = Date.now()
  const tick = await clockNow($)
  const prev = (await read($, codex)).find(r => r.file === f)
  if (gen !== targetGen) return
  const isFresh = (view.lastEventAt ?? mtimeMs) > t - 90_000
  const run: CodexRun = {
    id: view.id ?? f,
    file: f,
    cwd: view.cwd ?? '',
    part: view.part,
    role: view.role,
    startedAt: view.startedAt ?? mtimeMs,
    lastEventAt: view.lastEventAt ?? mtimeMs,
    endedAt: view.done ? (prev?.endedAt ?? view.lastEventAt ?? t) : undefined,
    isError: view.isError || undefined,
    commentary: view.commentary,
    commentarySeenAt: view.commentary === prev?.commentary ? prev?.commentarySeenAt : isFresh ? tick : undefined,
    activity: view.activity,
    wrote: view.wrote,
    final: view.final,
    mtimeMs,
  }
  await update($, codex, list => [...list.filter(r => r.file !== f), run].sort((a, b) => a.startedAt - b.startedAt).slice(-10))
  if (run.commentary !== undefined && run.commentarySeenAt !== undefined) {
    busyUntil = Math.max(busyUntil, run.commentarySeenAt + (run.commentary.length * 1000) / 110 + 200)
  }
  if (!isFresh) return
  const name = run.part ?? 'job'
  const turn = `${run.id}:${run.startedAt}`
  if (run.endedAt === undefined) {
    await send($, `${turn}:out:${name}`, 'to-codex', `${name} packet${run.role ? ` · ${run.role.toLowerCase()}` : ''}`)
  }
  for (const wrote of run.wrote) await send($, `${run.id}:file:${wrote}`, 'to-claude', wrote)
  if (run.endedAt !== undefined && prev?.endedAt === undefined && prev !== undefined) {
    await send($, `${turn}:end:${run.lastEventAt}`, 'to-claude', `${name} ${run.isError ? 'failed' : 'done'}`, run.isError)
    $.ui.toast(`Codex ${run.isError ? 'stopped on' : 'finished'} ${name}${run.final ? `: ${firstLine(run.final, 90)}` : ''}`)
  }
  startAnim($)
}

// ── Claude: the main loop's response stream ─────────────────────────────────

const argOf = (json: string) =>
  json.match(/"(?:command|description|file_path|pattern|url|query|prompt|skill)"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1]?.replace(/\\n/g, ' ').replace(/\\"/g, '"')

function observe(chunk: { kind: string; index?: number; text?: string; name?: string; json?: string }): boolean {
  const t = Date.now()
  const live = stream.live
  if (chunk.kind === 'thinking') {
    if (live.mode !== 'thinking') stream.live = { mode: 'thinking', text: '', since: t }
    stream.live.text = (stream.live.text + (chunk.text ?? '')).slice(-600)
  } else if (chunk.kind === 'text') {
    if (live.mode !== 'writing' || stream.index !== chunk.index) stream.live = { mode: 'writing', text: '', since: t }
    stream.live.text = (stream.live.text + (chunk.text ?? '')).slice(-1200)
  } else if (chunk.kind === 'tool') {
    stream.input = ''
    stream.live = { mode: 'tool', text: '', since: t, tool: chunk.name }
  } else if (chunk.kind === 'input') {
    stream.input = (stream.input + (chunk.json ?? '')).slice(0, 4000)
    const arg = argOf(stream.input)
    if (arg !== undefined) stream.live = { ...stream.live, arg }
  } else {
    return false
  }
  stream.index = chunk.index ?? stream.index
  stream.isDirty = true
  return true
}

// ── The animation frame: on while anything moves, off when the pane is still ──

function startAnim($: EngineInterface) {
  if (anim !== undefined || !isTandemActive()) return
  anim = $.clock.every(90, () => void frame($))
}

async function frame($: EngineInterface) {
  if (isFraming) return
  isFraming = true
  try {
    const t = await clockNow($)
    if (stream.isDirty) {
      stream.isDirty = false
      const live = { ...stream.live }
      await update($, claude, () => live)
    }
    await update($, now, () => t)
    // Judged from module state, not five state reads a frame. The stream's own mode counts,
    // so a response whose first chunk is still on its way keeps the frame alive.
    const moving = stream.live.mode !== 'idle' || stream.isDirty || t < busyUntil || activeCount > 0
    if (!moving || !isTandemActive()) {
      anim?.cancel()
      anim = undefined
    }
  } catch {
    // decoration only
  } finally {
    isFraming = false
  }
}

// ── Claude-side runs (subagents, headless claude) ──────────────────────────

/** The id a background launch will be reported under, from the tool's own result. */
const backgroundId = (result: unknown): string | undefined => {
  const r = (result ?? {}) as { backgroundTaskId?: unknown; status?: unknown; agentId?: unknown; taskId?: unknown }
  if (typeof r.backgroundTaskId === 'string') return r.backgroundTaskId
  if (r.status === 'async_launched' && typeof r.agentId === 'string') return r.agentId
  if (r.status === 'remote_launched' && typeof r.taskId === 'string') return r.taskId
  return undefined
}

async function refreshCounts($: EngineInterface) {
  const [rs, cx] = await Promise.all([read($, runs), read($, codex)])
  activeCount = rs.filter(r => r.endedAt === undefined).length + cx.filter(r => r.endedAt === undefined).length
}

/** Ends every waiting run whose notification has been seen, whichever arrived first. */
async function settleNotified($: EngineInterface) {
  const waiting = (await read($, runs)).filter(r => r.endedAt === undefined && r.taskId !== undefined)
  const done = waiting.flatMap(r => {
    const o = notified.get(r.taskId ?? '') ?? notified.get(r.id)
    return o ? [{ id: r.id, ids: [r.taskId ?? '', r.id], isError: o.isError }] : []
  })
  if (done.length === 0) return
  await update($, runs, list => list.map(r => {
    const d = done.find(x => x.id === r.id)
    return d ? { ...r, endedAt: Date.now(), isError: d.isError } : r
  }))
  for (const d of done) for (const id of d.ids) notified.delete(id)
  await refreshCounts($)
}

async function track<R extends { deny?: string; isError?: boolean; result?: unknown }>($: EngineInterface, label: string, id: string, run: () => Promise<R>): Promise<R> {
  const t = Date.now()
  activeCount += 1
  // The pane's bookkeeping runs beside the tool, never ahead of it.
  const started = update($, runs, list => [...list.filter(r => r.id !== id), { id, side: 'claude', label, startedAt: t } as LiveRun].slice(-20)).catch(() => undefined)
  startAnim($)
  const settle = async (patch: (r: LiveRun) => LiveRun) => {
    await started
    await update($, runs, list => list.map(r => (r.id === id ? patch(r) : r))).catch(() => undefined)
    await refreshCounts($).catch(() => undefined)
  }
  let ran: R
  try {
    ran = await run()
  } catch (error) {
    void settle(r => ({ ...r, endedAt: Date.now(), isError: true }))
    throw error
  }
  const taskId = ran.deny === undefined ? backgroundId(ran.result) : undefined
  void settle(r =>
    taskId === undefined ? { ...r, endedAt: Date.now(), isError: ran.deny !== undefined || ran.isError === true } : { ...r, taskId },
  ).then(() => (taskId === undefined ? undefined : settleNotified($)))
  return ran
}

const hasNotification = (content: readonly unknown[]): boolean =>
  content.some(block => {
    const b = block as { text?: unknown; content?: unknown }
    if (typeof b.text === 'string') return b.text.includes('<task-notification>')
    if (typeof b.content === 'string') return b.content.includes('<task-notification>')
    return Array.isArray(b.content) && hasNotification(b.content)
  })

const textOf = (content: readonly unknown[]): string =>
  content
    .map(block => {
      const b = block as { text?: unknown; content?: unknown }
      if (typeof b.text === 'string') return b.text
      if (typeof b.content === 'string') return b.content
      if (Array.isArray(b.content)) return textOf(b.content)
      return ''
    })
    .join('\n')

// ── The 1s poll ─────────────────────────────────────────────────────────────

async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    ticks += 1
    const gen = targetGen
    const path = await read($, file)
    if (path === null) {
      // No TANDEM.md yet: look for one every few seconds, and open the pane when it appears.
      if (ticks % 5 === 0 && (await discoverHere($))) openPane($, PANE, TITLE)
      return
    }
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (gen !== targetGen) return
    if (stat && stat.mtimeMs !== (await read($, doc))?.mtimeMs) await reloadIfCurrent($, path)
    await pollCodex($, dirOf(path), gen)
    await refreshCounts($)
    const active = (await read($, codex)).filter(r => r.endedAt === undefined)
    $.ui.status(active.length === 0 ? undefined : `⇄ Codex ${active.map(r => r.part ?? 'job').join(', ')} · ${ago(Date.now() - active[0]!.startedAt)}`)
    if (activeCount > 0) startAnim($)
    else if (anim === undefined && openPanes.has(PANE)) {
      const t = await clockNow($)
      await update($, now, () => t)
    }
  } catch {
    // decoration only
  } finally {
    isPolling = false
  }
}

// ── Tandem Arcade ───────────────────────────────────────────────────────────

/** One per surface showing the arcade: its own world (layouts differ by size), canvas and last draw. */
type ArcadeView = { world: World; w: number; h: number; canvas?: Canvas; svg?: string; drawnAt: number }
const arcadeViews = new Map<string, ArcadeView>()
let arcadeTimer: Timer | undefined
let arcadeGen = 0
let arcadeFrames = 0
let isArcadeFraming = false

async function arcadeInputs($: EngineInterface): Promise<Inputs> {
  const [d, c, r, x, tr] = await Promise.all([read($, doc), read($, claude), read($, runs), read($, codex), read($, transfers)])
  // The stream buffer is fresher than the state between frames.
  return { doc: d, claude: stream.isDirty ? stream.live : c, runs: r, codex: x, transfers: tr }
}

/** Steps and draws one surface's view; for SVG, shrinks the canvas until the source fits its limit. */
function drawView(view: ArcadeView, surface: string, inp: Inputs, t: number) {
  stepArcade(view.world, layout(view.w, view.h, inp.doc), inp, t)
  view.canvas = renderArcade(view.world, layout(view.w, view.h, inp.doc), inp, t)
  if (surface === 'terminal') return
  view.svg = toSvg(view.canvas)
  while (view.svg.length > SVG_LIMIT - 2048 && view.w > 48) {
    view.w = Math.floor(view.w * 0.8)
    view.h = Math.floor(view.h * 0.8)
    stepArcade(view.world, layout(view.w, view.h, inp.doc), inp, t)
    view.canvas = renderArcade(view.world, layout(view.w, view.h, inp.doc), inp, t)
    view.svg = toSvg(view.canvas)
  }
}

const isLively = (inp: Inputs, views: Iterable<ArcadeView>, t: number) =>
  inp.claude.mode !== 'idle' ||
  inp.codex.some(r => r.endedAt === undefined) ||
  inp.runs.some(r => r.endedAt === undefined) ||
  inp.transfers.some(x => t < x.startAt + TRANSFER_MS + HOLD_MS + 600) ||
  [...views].some(v => v.world.poofs.length > 0 || [...v.world.actors.values()].some(a => Math.hypot(a.tx - a.x, a.ty - a.y) > 0.4))

async function arcadeFrame($: EngineInterface, gen: number) {
  if (isArcadeFraming) return
  isArcadeFraming = true
  try {
    if (gen !== arcadeGen || arcadeViews.size === 0) return stopArcade()
    const t = await clockNow($)
    const inp = await arcadeInputs($)
    // Idle (everyone napping, nothing moving): a quarter of the frames is enough for the Z's.
    arcadeFrames += 1
    if (!isLively(inp, arcadeViews.values(), t) && arcadeFrames % 4 !== 0) return
    let isSvgDirty = false
    for (const [surface, view] of arcadeViews) {
      if (surface !== 'terminal' && Date.now() - view.drawnAt > 3000) {
        // Ticks no longer redraw it: the pane is gone (closed, or unloaded without a close).
        arcadeViews.delete(surface)
        continue
      }
      drawView(view, surface, inp, t)
      if (surface === 'terminal') {
        const cells = toRasterCells(view.canvas!)
        const res = await $.ui.blit({ requestId: ARCADE, key: 'arcade', cells: cells.cells, columns: cells.columns, rows: cells.rows })
        // Not mounted, or another size: drop it; a render (resize, reopen) brings it back.
        if ('deny' in res && res.deny !== undefined) arcadeViews.delete(surface)
      } else {
        isSvgDirty = true
      }
    }
    if (gen !== arcadeGen) return
    if (isSvgDirty) await update($, arcadeTick, n => (n + 1) % 1_000_000)
    if (arcadeViews.size === 0) stopArcade()
  } catch {
    // decoration only
  } finally {
    isArcadeFraming = false
  }
}

function startArcade($: EngineInterface) {
  if (arcadeTimer !== undefined) return
  const gen = arcadeGen
  arcadeTimer = $.clock.every(110, () => void arcadeFrame($, gen))
}

function stopArcade() {
  arcadeTimer?.cancel()
  arcadeTimer = undefined
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    loadedAt = Date.now()
    await $.command.register({
      name: 'tandem',
      description: 'Open the Tandem pane (Claude | Codex lanes + workflow). `/tandem arcade` for the pixel view; a path or folder for another TANDEM.md; anything else starts a tandem job',
      argumentHint: '[arcade | path | job to run in tandem]',
    })
    if (await discoverHere($)) openPane($, PANE, TITLE)
    await update($, claude, () => IDLE)
    $.clock.every(1000, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'tandem' }, async ($, e) => {
    const arg = e.args.trim()
    if (/^arcade$/i.test(arg)) {
      if ((await read($, doc)) === null) await discover($)
      openPanes.add(ARCADE)
      await $.ui.open({ id: ARCADE, title: ARCADE_TITLE })
      return { text: 'Tandem Arcade open.' }
    }
    if (arg !== '') {
      const target = await resolveTarget($, arg)
      if (!(await load($, target))) {
        // Not a TANDEM.md: words, not a path, are a job to run in tandem.
        if (!looksLikePath(arg)) {
          openPanes.add(PANE)
          await $.ui.open({ id: PANE, title: TITLE })
          // A command.run hook cannot submit while it holds the turn: queue it just after.
          $.clock.after(100, () => void $.prompt.submit({ text: `Use the codex-claude-tandem skill for this job: ${arg}`, asUser: true }))
          return { text: 'Starting a tandem run on that. The pane fills in once TANDEM.md is written.' }
        }
        return { text: `No TANDEM.md at ${target}` }
      }
    } else if ((await read($, doc)) === null) {
      await discover($)
    }
    openPanes.add(PANE)
    await $.ui.open({ id: PANE, title: TITLE })
    const path = await read($, file)
    return { text: path ? `Tandem pane open on ${path}` : 'Tandem pane open. No TANDEM.md found yet: /tandem <path>, or /tandem <job> to start one.' }
  })

  on('ui.close', ($, e, next) => {
    openPanes.delete(e.id)
    if (e.id === ARCADE) {
      arcadeGen += 1
      arcadeViews.clear()
      stopArcade()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}`
    if (e.tool === 'Bash') {
      if (codexRun(e.command) !== undefined) {
        // The rollout poll finds the session; look sooner than the next second.
        if (isTandemActive()) $.clock.after(1500, () => void poll($))
        return next(e)
      }
      const label = claudeRun(e.command)
      if (label === undefined || !isTandemActive()) return next(e)
      return track($, e.run_in_background === true ? `${label} · bg` : label, id, () => next(e))
    }
    if (e.tool === 'Agent') {
      if (!isTandemActive()) return next(e)
      return track($, `subagent · ${e.description || e.subagent_type || 'agent'}`, id, () => next(e))
    }
    const path = (e as unknown as { file_path?: unknown }).file_path
    if (typeof path !== 'string' || !isTandem(path)) return next(e)
    const ran = await next(e)
    const before = await read($, file)
    // A TANDEM.md this session starts working on opens the pane; later edits only refresh it.
    if ((await load($, path)) && before !== path) openPane($, PANE, TITLE)
    return ran
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.message.type === 'assistant' || !isTandemActive() || !hasNotification(e.message.content)) return stored
    // Remember every outcome (its run may not have recorded the id yet), then settle off the append's path.
    const t = Date.now()
    for (const [id, o] of notificationOutcomes(textOf(e.message.content))) notified.set(id, { ...o, at: t })
    for (const [id, o] of notified) if (t - o.at > 6 * 3600_000) notified.delete(id)
    void settleNotified($).catch(() => undefined)
    return stored
  }).catch(($, e, next) => next(e))

  // The main loop's stream, chunk by chunk: observed, passed on untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !isTandemActive()) return yield* next(e)
    for await (const chunk of next(e)) {
      try {
        if (observe(chunk as Parameters<typeof observe>[0]) && anim === undefined) startAnim($)
      } catch {
        // the pane is decoration: never let it cost a response
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      stream.live = { mode: 'idle', text: '', since: Date.now(), summary: e.answer ? firstLine(e.answer, 160) : undefined }
      stream.isDirty = true
      startAnim($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    openPanes.add(PANE)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [current, path, live, cx, wire, cl, ch, stored] = await Promise.all([
      read($, doc),
      read($, file),
      read($, runs),
      read($, codex),
      read($, transfers),
      read($, claude),
      read($, changes),
      read($, now),
    ])
    const t = Math.max(stored, await clockNow($))
    const width = e.props.bodyColumns
    const stacked = width < 64
    const laneWidth = stacked ? width : Math.floor((width - 1) / 2)
    const inner = Math.max(10, laneWidth - 4)

    // Reloads the current TANDEM.md (the poll does, when it changed) and Codex; never switches files.
    const refresh = async () => {
      if ((await read($, file)) === null) await discover($)
      await update($, doc, d => (d === null ? d : { ...d, mtimeMs: -1 }))
      await poll($)
    }
    const arcade = async () => {
      openPanes.add(ARCADE)
      await $.ui.open({ id: ARCADE, title: ARCADE_TITLE, focus: true })
    }

    if (current === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Tandem</Text>
          <Text dimColor>No TANDEM.md in this project. Run /tandem with a job to start one, or /tandem path/to/TANDEM.md.</Text>
          <Button key="refresh" onPress={refresh}>Look again</Button>
        </Box>
      )
    }

    // ── workflow steps ──
    const steps = workflow(current, cx.length > 0)
    const stepColor = (s: (typeof steps)[number]['state']) =>
      s === 'done' ? 'success' : s === 'current' ? 'warning' : s === 'warn' ? 'error' : 'inactive'
    const stepGlyph = (s: (typeof steps)[number]['state']) =>
      s === 'done' ? '✓' : s === 'current' ? pulse(t) : s === 'warn' ? '!' : '·'

    // ── the wire ──
    const packet = activeTransfer(wire, t)
    const queued = queuedCount(wire, t)
    const compact = width < 40
    const trackWidth = Math.max(4, width - (compact ? 6 : 16) - (queued > 0 ? 4 : 0))
    const segments = wireFrame(trackWidth, packet, t)
    const last = [...wire].reverse().find(x => t >= x.startAt + TRANSFER_MS)
    const packetColor = packet?.isError ? 'error' : packet?.dir === 'to-codex' ? 'suggestion' : 'claude'
    const idleText = last ? ` ${last.label} → ${last.dir === 'to-codex' ? 'Codex' : 'Claude'} · ${ago(t - last.startAt - TRANSFER_MS)} ago ` : ' ⇄ '
    const idleLabel = idleText.length > trackWidth ? ` ${clip(idleText, Math.max(1, trackWidth - 2))} ` : idleText
    const idlePad = Math.max(0, trackWidth - idleLabel.length)
    const wireRow = (
      <Box key="wire" flexDirection="row">
        <Text bold color="claude">{compact ? 'C ' : 'CLAUDE '}</Text>
        {segments === undefined ? (
          <Text dimColor wrap="truncate-end">{`${'─'.repeat(Math.floor(idlePad / 2))}${idleLabel}${'─'.repeat(Math.ceil(idlePad / 2))}`}</Text>
        ) : (
          segments.map((s, i) => (
            <Text key={`seg-${i}`} color={s.style === 'track' ? undefined : packetColor} dimColor={s.style === 'track'} bold={s.style === 'packet'}>
              {s.text}
            </Text>
          ))
        )}
        <Text bold color="suggestion">{compact ? ' X' : ' CODEX'}</Text>
        {queued > 0 && <Text dimColor>{` +${queued}`}</Text>}
      </Box>
    )

    // ── part rows, with new/changed flashes ──
    const flash = (id: string) => ch.find(c => c.id === id && t - c.at < FLASH_MS)
    const row = (part: TandemPart, role: 'lead' | 'second') => {
      const f = flash(part.id)
      const label = part.id === part.name ? part.id : `${part.id}  ${part.name}`
      const shown = f?.kind === 'new' ? reveal(label, f.at, t, 60) : label
      const blink = f !== undefined && Math.floor((t - f.at) / 400) % 2 === 0
      return (
        <Box key={`${role}-${part.id}`} flexDirection="row" gap={1}>
          <Text color={part.status === 'accepted' ? 'success' : part.status === 'blocked' ? 'error' : f ? 'warning' : undefined}>{GLYPH[part.status]}</Text>
          <Text bold={role === 'lead' || f !== undefined} dimColor={role === 'second' && f === undefined} wrap="truncate-end">
            {shown}
          </Text>
          {f?.kind === 'new' && <Text color="warning" inverse={blink}>{' ✦ new '}</Text>}
          {f?.kind === 'status' && <Text color="warning" inverse={blink}>{` ${f.from} → ${f.to} `}</Text>}
        </Box>
      )
    }

    // ── Claude's live block ──
    const claudeLive = () => {
      const subs = live.filter(r => r.endedAt === undefined)
      const elapsed = ago(Date.now() - cl.since)
      const block =
        cl.mode === 'thinking' ? (
          <Box key="cl" flexDirection="column">
            <Text color="claude" bold>{`${star(t)} Thinking… (${elapsed})`}</Text>
            {cl.text.trim() !== '' && <Text dimColor italic wrap="truncate-start">{cl.text.replace(/\s+/g, ' ').slice(-inner * 2)}</Text>}
          </Box>
        ) : cl.mode === 'writing' ? (
          <Box key="cl" flexDirection="column">
            <Text color="claude">{`${star(t)} Writing…`}</Text>
            <Text wrap="wrap">{cl.text.replace(/\s+/g, ' ').slice(-inner * 3)}</Text>
          </Box>
        ) : cl.mode === 'tool' ? (
          <Box key="cl" flexDirection="column">
            <Text color="claude" wrap="truncate-end">{`${spin(t)} ${cl.tool ?? 'tool'}${cl.arg ? `(${cl.arg})` : ''}`}</Text>
          </Box>
        ) : (
          <Text key="cl" dimColor wrap="wrap">{cl.summary ? `✓ ${cl.summary}` : 'idle'}</Text>
        )
      return (
        <Box key="claude-live" flexDirection="column">
          {block}
          {subs.map(r => (
            <Text key={r.id} color="warning" wrap="truncate-end">{`${spin(t)} ${r.label} ${ago(Date.now() - r.startedAt)}`}</Text>
          ))}
        </Box>
      )
    }

    // ── Codex's live block ──
    const codexLive = () => {
      const wall = Date.now()
      const active = cx.filter(r => r.endedAt === undefined)
      const recent = cx.filter(r => r.endedAt !== undefined && wall - (r.endedAt ?? 0) < 30 * 60_000).slice(-2)
      if (active.length === 0 && recent.length === 0) return <Text key="cx" dimColor>idle</Text>
      return (
        <Box key="codex-live" flexDirection="column">
          {active.map(r => {
            const quiet = wall - r.lastEventAt > 2500 && !isTyping(r.commentary, r.commentarySeenAt, t)
            return (
              <Box key={r.id} flexDirection="column">
                <Text color="warning" bold wrap="truncate-end">
                  {`${spin(t)} ${r.part ?? 'codex'}${r.role ? ` · ${r.role.toLowerCase()}` : ''} · ${ago(wall - r.startedAt)}`}
                </Text>
                {r.commentary !== undefined && <Text wrap="wrap">{reveal(clip(r.commentary, inner * 3), r.commentarySeenAt, t)}</Text>}
                <Text dimColor wrap="truncate-end">{quiet ? `${star(t)} thinking…` : `↳ ${r.activity ?? 'starting'}`}</Text>
              </Box>
            )
          })}
          {recent.map(r => (
            <Text key={r.id} dimColor wrap="truncate-end">
              {`${r.isError ? '✗' : r.isStalled ? '…' : '✓'} ${r.part ?? 'codex'} ${r.isError ? 'stopped' : r.isStalled ? 'went quiet' : 'done'} · ${r.final ? firstLine(r.final, inner) : `${r.wrote.length} file(s)`}`}
            </Text>
          ))}
        </Box>
      )
    }

    const lane = (side: Exclude<Side, 'both' | 'none'>) => {
      const leads = current.parts.filter(p => p.lead === side || p.lead === 'both')
      const seconds = current.parts.filter(p => p.second === side && p.lead !== side)
      const accent = side === 'claude' ? 'claude' : 'suggestion'
      const arrival = arrivalOn(wire, side, t)
      return (
        <Box key={side} flexDirection="column" width={laneWidth} borderStyle={arrival ? 'bold' : 'round'} borderColor={accent} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={accent} inverse={arrival !== undefined}>{side === 'claude' ? ' CLAUDE ' : ' CODEX '}</Text>
            <Text dimColor={arrival === undefined} color={arrival ? accent : undefined} wrap="truncate-start">
              {arrival ? `${side === 'codex' ? '▶' : '◀'} ${arrival.label}` : side === 'claude' ? 'builds & lands' : 'digs'}
            </Text>
          </Box>
          {side === 'claude' ? claudeLive() : codexLive()}
          <Text dimColor>{`LEAD (${leads.length})`}</Text>
          {leads.length === 0 ? <Text dimColor>  —</Text> : leads.map(p => row(p, 'lead'))}
          <Text dimColor>{`SECOND (${seconds.length})`}</Text>
          {seconds.length === 0 ? <Text dimColor>  —</Text> : seconds.map(p => row(p, 'second'))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{current.title}</Text>
          <Text dimColor wrap="truncate-start">{path ? short(path) : ''}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {steps.map((s, i) => (
            <Text key={`step-${i}`} color={stepColor(s.state)} bold={s.state === 'current'}>
              {stepGlyph(s.state)} {i + 1} {s.label}{s.note ? ` (${s.note})` : ''}{i < steps.length - 1 ? ' →' : ''}
            </Text>
          ))}
        </Box>
        {wireRow}
        <Box flexDirection={stacked ? 'column' : 'row'} gap={1}>
          {lane('claude')}
          {lane('codex')}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>SWAP LOG</Text>
          {current.swaps.length === 0 ? (
            <Text dimColor>  none</Text>
          ) : (
            current.swaps.slice(-3).map((s, i) => (
              <Text key={`swap-${i}`} wrap="truncate-end">  {s}</Text>
            ))
          )}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button key="refresh" onPress={refresh}>Refresh</Button>
          <Button key="arcade" onPress={arcade}>Arcade</Button>
          <Text dimColor>○ assigned → handed off ◆ delivered ◐ review ✓ accepted</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: ARCADE }, async ($, e) => {
    // A close that lands while this draw is under way wins: the draw starts no clock.
    const gen = arcadeGen
    openPanes.add(ARCADE)
    const surface = e.surface
    const isTerminal = surface === 'terminal'
    if (!isTerminal) await read($, arcadeTick) // subscribes: each tick redraws the SVG
    const cols = Math.max(32, Math.min(isTerminal ? 240 : 160, e.props.bodyColumns))
    const bodyRows = e.props.scroll?.bodyRows ?? 24
    // Not `h`: that name is the JSX factory.
    const pixelRows = isTerminal ? Math.max(24, Math.min(64, (bodyRows - 3) * 2)) : Math.max(36, Math.min(64, Math.round(cols * 0.42)))
    let view = arcadeViews.get(surface)
    if (view === undefined || (isTerminal && (view.w !== cols || view.h !== pixelRows)) || (!isTerminal && view.canvas === undefined)) {
      view = { world: view?.world ?? newWorld(), w: cols, h: pixelRows, drawnAt: Date.now() }
      drawView(view, surface, await arcadeInputs($), await clockNow($))
    }
    view.drawnAt = Date.now()
    if (gen === arcadeGen) {
      arcadeViews.set(surface, view)
      startArcade($)
    }

    const [cl, cx] = await Promise.all([read($, claude), read($, codex)])
    const activeCodex = cx.filter(r => r.endedAt === undefined)
    const claudeLine =
      cl.mode === 'thinking' ? 'Claude is thinking' : cl.mode === 'writing' ? 'Claude is writing' : cl.mode === 'tool' ? `Claude is using ${cl.tool ?? 'a tool'}` : 'Claude is on a break'
    const codexLine =
      activeCodex.length === 0 ? 'Codex is charging' : `Codex ×${activeCodex.length}: ${activeCodex.map(r => `${r.part ?? 'job'} (${r.activity ?? 'starting'})`).join(', ')}`
    const caption = `${claudeLine} · ${codexLine}`

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e as typeof e & { surface: 'terminal' })
      const cells = toRasterCells(view.canvas!)
      return (
        <Box flexDirection="column">
          <Raster key="arcade" columns={cells.columns} rows={cells.rows} cells={cells.cells} />
          <Text dimColor wrap="truncate-end">{caption}</Text>
        </Box>
      )
    }
    // Desktop, VS Code and mobile draw SVG; the same pixels as paths, held under the source limit.
    const { Box, Text, Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })
    return (
      <Box flexDirection="column">
        <Svg source={view.svg ?? toSvg(view.canvas!)} alt={`Tandem Arcade: ${caption}`} width={Math.min(1100, cols * 7)} />
        <Text dimColor wrap="truncate-end">{caption}</Text>
      </Box>
    )
  })
}
