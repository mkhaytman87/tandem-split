import type { PartStatus, Side, TandemDoc, TandemPart } from '../types'

export type Step = { label: string; state: 'done' | 'current' | 'todo' | 'warn' | 'idle'; note?: string }

const sideOf = (cell: string): Side => {
  const lower = cell.toLowerCase()
  const codex = lower.includes('codex')
  const claude = lower.includes('claude')
  if (codex && claude) return 'both'
  if (codex) return 'codex'
  if (claude) return 'claude'
  return 'none'
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const NEGATED = /\b(not|no|un|pre|pending|awaiting|before|needs?)[\s-]*(yet\s+)?(accept|sign|done|complete|review|deliver)/i

const statusOf = (heading: string): PartStatus | undefined => {
  const negated = NEGATED.test(heading)
  if (!negated && /accept|sign[- ]?off|\bdone\b|complete/i.test(heading)) return 'accepted'
  if (/\bLEAD:/i.test(heading)) return 'handed-off'
  if (negated) return undefined
  if (/blocked|stalled/i.test(heading)) return 'blocked'
  if (/review|correction|critique/i.test(heading)) return 'in-review'
  if (/deliver|handback|result|report/i.test(heading)) return 'delivered'
  return undefined
}

const splitId = (cell: string): { id: string; name: string } => {
  const dash = cell.match(/^(.+?)\s+[—–-]\s+(.+)$/)
  if (dash) return { id: dash[1]!.trim(), name: dash[2]!.trim() }
  const [id = cell, ...rest] = cell.trim().split(/\s+/)
  return { id, name: rest.join(' ') || id }
}

/** The body lines of every `##`-or-deeper section whose heading matches, in document order. */
const sections = (lines: string[], title: RegExp): string[][] => {
  const out: string[][] = []
  let body: string[] | undefined
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      body = /^#{2,4}\s/.test(line) && title.test(line) ? [] : undefined
      if (body) out.push(body)
      continue
    }
    body?.push(line)
  }
  return out
}

const section = (lines: string[], title: RegExp): string[] => sections(lines, title)[0] ?? []

export const parseTandem = (text: string, mtimeMs = 0): TandemDoc => {
  const lines = text.split(/\r?\n/)
  const title = (lines.find(l => /^#\s/.test(l)) ?? '# TANDEM').replace(/^#\s+/, '').trim()

  // One pass in document order: a Parts row (re)assigns a part and resets its status; a heading
  // naming parts moves only those that exist by then; a wrap-up heading moves every part so far.
  const parts: TandemPart[] = []
  let inParts = false
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      inParts = /^#{2,4}\s/.test(line) && /\bparts\b/i.test(line)
      if (!/^#{3,4}\s/.test(line)) continue
      const heading = line.replace(/^#{3,4}\s+/, '')
      const status = statusOf(heading)
      const hits = parts.filter(p => new RegExp(`(^|[^\\w-])${escape(p.id)}([^\\w-]|$)`, 'i').test(heading))
      const isWrapUp = hits.length === 0 && status === 'accepted' && /\b(final acceptance|all parts)\b/i.test(heading)
      for (const part of isWrapUp ? parts : hits) {
        if (status === 'handed-off') {
          if (part.status === 'assigned') part.status = status
          continue
        }
        part.notes += 1
        if (status) part.status = status
      }
      continue
    }
    if (!inParts || !line.trim().startsWith('|')) continue
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    if (cells.length < 2) continue
    if (/^:?-{2,}/.test(cells[0]!) || /^part$/i.test(cells[0]!)) continue
    const { id, name } = splitId(cells[0]!)
    const part: TandemPart = {
      id,
      name,
      lead: sideOf(cells[1] ?? ''),
      leadLabel: (cells[1] ?? '').slice(0, 48),
      second: sideOf(cells[2] ?? ''),
      status: 'assigned',
      notes: 0,
    }
    const at = parts.findIndex(p => p.id === id)
    if (at >= 0) parts[at] = part
    else parts.push(part)
  }

  const body = text.replace(/AGREE\s*(\/|or|and)\s*CONTEST/gi, '')
  const swaps = section(lines, /swap log/i)
    .map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(l => l.length > 0 && !/^none\.?$/i.test(l) && !/^\|?\s*:?-{2,}/.test(l))

  return {
    title,
    parts,
    agreed: /\bAGREE\b/.test(body) || /confirmed the (routing )?split/i.test(body),
    contested: /\bCONTEST(ED|S)?\b/.test(body),
    swaps,
    mtimeMs,
  }
}

export const workflow = (doc: TandemDoc | null, codexRan: boolean): Step[] => {
  const parts = doc?.parts ?? []
  const has = parts.length > 0
  const steps: Step[] = [
    { label: 'Decompose', state: has ? 'done' : 'todo' },
    { label: 'Assign', state: has && parts.every(p => p.lead !== 'none') ? 'done' : 'todo' },
    { label: 'Confirm', state: doc?.contested ? 'warn' : doc?.agreed ? 'done' : 'todo' },
    { label: 'Hand off', state: parts.some(p => p.status !== 'assigned') || codexRan ? 'done' : 'todo' },
    { label: 'Work', state: has && parts.every(p => p.status === 'accepted') ? 'done' : 'todo' },
  ]
  const current = steps.findIndex(s => s.state === 'todo')
  if (current >= 0) steps[current]!.state = 'current'
  const swaps = doc?.swaps.length ?? 0
  steps.push({ label: 'Re-assign', state: swaps > 0 ? 'done' : 'idle', note: swaps > 0 ? `${swaps}` : undefined })
  return steps
}

export const codexRun = (command: string): string | undefined => {
  if (!/\bcodex\s+(exec|resume|e)\b/.test(command)) return undefined
  const model = command.match(/(?:-m|--model)[\s=]+["']?([\w.\-]+)/)?.[1] ?? 'default model'
  const sandbox = command.match(/--sandbox[\s=]+([\w-]+)/)?.[1]
  const verb = /\bresume\b/.test(command) ? 'resume' : 'exec'
  return `codex ${verb} · ${model}${sandbox ? ` · ${sandbox}` : ''}`
}

export const claudeRun = (command: string): string | undefined =>
  /\bclaude\s+(-p|--print)\b/.test(command) ? 'claude -p (headless)' : undefined

// A background task's notification row (<task-notification> with <task-id>, <tool-use-id>, <status>)
// reports on exactly one task. Returns whether it ended in error, or undefined when no notification
// in the text is about one of `ids` or it is not final yet. Prose mentioning an id never counts.
/** Every final outcome a text's task notifications report, by each id they name. */
export const notificationOutcomes = (text: string): Map<string, { isError: boolean }> => {
  const out = new Map<string, { isError: boolean }>()
  for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const tag = (name: string) => block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1]
    const status = tag('status')?.toLowerCase()
    if (status === undefined || status === 'running' || status === 'pending') continue
    const exit = (tag('summary') ?? '').match(/exit code (\d+)/i)?.[1]
    const outcome = { isError: status !== 'completed' || (exit !== undefined && exit !== '0') }
    for (const id of [tag('task-id'), tag('tool-use-id')]) if (id) out.set(id, outcome)
  }
  return out
}

export const taskOutcome = (text: string, ids: readonly string[]): { isError: boolean } | undefined => {
  const wanted = ids.filter(id => id.length > 0)
  for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const tag = (name: string) => block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1]
    const named = [tag('task-id'), tag('tool-use-id')].filter((v): v is string => v !== undefined)
    if (!named.some(id => wanted.includes(id))) continue
    const status = tag('status')?.toLowerCase()
    if (status === undefined || status === 'running' || status === 'pending') return undefined
    const exit = (tag('summary') ?? '').match(/exit code (\d+)/i)?.[1]
    return { isError: status !== 'completed' || (exit !== undefined && exit !== '0') }
  }
  return undefined
}

// ── Codex rollout logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ──────────

export type RolloutView = {
  id?: string
  cwd?: string
  startedAt?: number
  part?: string
  role?: 'LEAD' | 'SECOND'
  commentary?: string
  activity?: string
  wrote: string[]
  final?: string
  done: boolean
  isError: boolean
  lastEventAt?: number
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

const itemText = (item: Json): string =>
  (Array.isArray(item.content) ? item.content : [])
    .map(c => str(obj(c).text) ?? '')
    .join('\n')

const describeCommand = (item: Json): string => {
  const parsed = obj(Array.isArray(item.parsed_cmd) ? item.parsed_cmd[0] : undefined)
  const kind = str(parsed.type)
  const name = str(parsed.name) ?? str(parsed.path)
  if (kind === 'read' && name) return `read ${name}`
  if (kind === 'list_files') return `list ${str(parsed.path) ?? '.'}`
  if (kind === 'search') return `search ${str(parsed.query) ?? str(parsed.cmd) ?? ''}`.trim()
  const argv = Array.isArray(item.command) ? item.command.map(String) : []
  const cmd = (str(parsed.cmd) ?? argv.at(-1) ?? 'command').trim()
  const head = cmd.split('\n')[0]!.trim()
  // An inline script (python3 - <<'PY' ...) reads as the interpreter it feeds.
  const script = head.match(/^(\S+)\s+-?\s*<</)?.[1]
  return script ? `ran a ${baseName(script)} script` : `ran ${head.replace(/\s+/g, ' ').slice(0, 80)}`
}

/**
 * Folds rollout JSONL into what the pane shows. Pass the previous view to fold
 * only the bytes appended since: the first turn's hand-off and the files
 * written so far are kept, so a large log never has to be re-read whole.
 */
export const parseRollout = (text: string, prev?: RolloutView): RolloutView => {
  const view: RolloutView = prev ? { ...prev, wrote: [...prev.wrote] } : { wrote: [], done: false, isError: false }
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: Json
    try {
      row = obj(JSON.parse(line))
    } catch {
      continue
    }
    const at = Date.parse(str(row.timestamp) ?? '')
    if (!Number.isNaN(at)) view.lastEventAt = Math.max(view.lastEventAt ?? 0, at)
    const p = obj(row.payload)
    if (row.type === 'session_meta') {
      view.id = str(p.id) ?? str(p.session_id) ?? view.id
      view.cwd = str(p.cwd) ?? view.cwd
      const started = Date.parse(str(p.timestamp) ?? str(row.timestamp) ?? '')
      if (!Number.isNaN(started)) view.startedAt = started
      continue
    }
    if (row.type === 'turn_context') {
      view.cwd ??= str(p.cwd)
      continue
    }
    if (row.type !== 'event_msg') continue
    if (p.type === 'task_started') {
      // A new turn (exec resume, or the next prompt): its answer and doings start over.
      view.done = false
      view.isError = false
      view.final = undefined
      view.commentary = undefined
      view.activity = undefined
    }
    if (p.type === 'task_complete') {
      view.done = true
      view.final = str(p.last_agent_message) ?? view.final
    }
    if (p.type === 'turn_aborted') {
      view.done = true
      view.isError = true
    }
    if (p.type === 'error') view.isError = true
    if (p.type !== 'item_completed') continue
    const item = obj(p.item)
    if (item.type === 'UserMessage') {
      const m = itemText(item).match(/You are (LEAD|SECOND) on part ([\w-]+(?:\.\d+)?)/)
      if (m) {
        view.role = m[1] as 'LEAD' | 'SECOND'
        view.part = m[2]
      }
    } else if (item.type === 'AgentMessage') {
      const t = itemText(item).trim()
      if (t !== '') {
        if (item.phase === 'final_answer') view.final = t
        else view.commentary = t
      }
    } else if (item.type === 'CommandExecution') {
      view.activity = describeCommand(item)
    } else if (item.type === 'FileChange') {
      for (const path of Object.keys(obj(item.changes))) {
        const name = baseName(path)
        if (!view.wrote.includes(name)) view.wrote.push(name)
        view.activity = `wrote ${name}`
      }
    } else if (item.type === 'McpToolCall') {
      view.activity = `tool ${str(item.tool) ?? str(item.name) ?? ''}`.trim()
    }
  }
  return view
}

/**
 * A rollout line too long to read whole (a file change carrying megabytes of
 * content): what can be told from its start. Its written paths come first.
 */
export const salvageLine = (view: RolloutView, lineStart: string): RolloutView => {
  const head = lineStart.slice(0, 4096)
  if (!/"type"\s*:\s*"FileChange"/.test(head)) return view
  const next = { ...view, wrote: [...view.wrote] }
  for (const m of lineStart.slice(0, 65536).matchAll(/"changes"\s*:\s*\{\s*"((?:[^"\\]|\\.)+)"/g)) {
    let path: string
    try {
      path = JSON.parse(`"${m[1]}"`) as string
    } catch {
      continue
    }
    const name = baseName(path)
    if (!next.wrote.includes(name)) next.wrote.push(name)
    next.activity = `wrote ${name}`
  }
  return next
}

const trimDir = (p: string) => p.replace(/^file:\/\//, '').replace(/\/+$/, '')

/** How a Codex session's folder sits relative to the tandem folder. */
export const dirRelation = (cwd: string, dir: string): 'same' | 'inside' | 'above' | 'apart' => {
  const a = trimDir(cwd)
  const b = trimDir(dir)
  if (a === b) return 'same'
  if (a.startsWith(`${b}/`)) return 'inside'
  if (b.startsWith(`${a}/`)) return 'above'
  return 'apart'
}

/** The tandem folder or inside it. A folder above it counts only when it is a repo root (checked by the caller). */
export const relatedDir = (cwd: string, dir: string): boolean => {
  const r = dirRelation(cwd, dir)
  return r === 'same' || r === 'inside'
}

/** First sentence-ish of a message, for one-line display. */
export const firstLine = (text: string, max = 140): string => {
  const flat = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  const cut = flat.match(/^(.{20,}?[.!?])(\s|$)/)?.[1] ?? flat
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut
}
