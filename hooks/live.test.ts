import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Transfer } from '../types'

import { TRANSFER_MS, nextSlot, reveal, wireFrame } from './anim'
import { dirRelation, firstLine, parseRollout, relatedDir } from './parse'

const DIR = '/Users/me/triage'
const iso = (ms: number) => new Date(ms).toISOString()
const T0 = Date.now()

const rollout = (opts: { done?: boolean; wrote?: boolean } = {}) =>
  [
    { timestamp: iso(T0), type: 'session_meta', payload: { id: 'sess-1', timestamp: iso(T0), cwd: DIR } },
    { timestamp: iso(T0 + 1), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(T0 + 2), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'You are LEAD on part T1 in ./TANDEM.md. Read TANDEM.md in full.' }] } } },
    { timestamp: iso(T0 + 3), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: 'I’ll read TANDEM.md and the routing rules, then execute T1.' }] } } },
    { timestamp: iso(T0 + 4), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'cat TANDEM.md'], parsed_cmd: [{ type: 'read', cmd: 'cat TANDEM.md', name: 'TANDEM.md' }] } } },
    ...(opts.wrote ? [{ timestamp: iso(T0 + 5), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { [`${DIR}/T1-FINDINGS.md`]: { type: 'add' } } } } }] : []),
    ...(opts.done ? [{ timestamp: iso(T0 + 6), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'AGREE. T1 acceptance met in T1-FINDINGS.md. Checked 223 refs.' } }] : []),
  ]
    .map(r => `${JSON.stringify(r)}\n`)
    .join('')

describe('parseRollout', () => {
  test('reads the session, its part and role, and what it is doing', async () => {
    const v = parseRollout(rollout())
    expect([v.id, v.cwd, v.part, v.role, v.done]).toEqual(['sess-1', DIR, 'T1', 'LEAD', false])
    expect(v.commentary).toContain('routing rules')
    expect(v.activity).toBe('read TANDEM.md')
  })
  test('files written and the final answer', async () => {
    const v = parseRollout(rollout({ wrote: true, done: true }))
    expect(v.wrote).toEqual(['T1-FINDINGS.md'])
    expect(v.done).toBe(true)
    expect(firstLine(v.final ?? '')).toBe('AGREE. T1 acceptance met in T1-FINDINGS.md.')
  })
  test('a torn first line from a tail read is skipped', async () => {
    expect(parseRollout(`{"timestamp": "x", "ty\n${rollout()}`).part).toBe('T1')
  })
  test('folders relate at and inside the tandem folder; above is the caller\'s repo-root call', async () => {
    expect(relatedDir(DIR, DIR)).toBe(true)
    expect(relatedDir(`${DIR}/sub`, DIR)).toBe(true)
    expect(dirRelation('/Users/me', DIR)).toBe('above')
    expect(relatedDir('/Users/me', DIR)).toBe(false)
    expect(relatedDir('/Users/other', DIR)).toBe(false)
    expect(relatedDir(`file://${DIR}/`, DIR)).toBe(true)
  })
})

test('an inline script reads as its interpreter', async () => {
  const line = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', "python3 - <<'PY'\nimport json\nPY"], parsed_cmd: [{ type: 'unknown', cmd: "python3 - <<'PY'\nimport json\nPY" }] } } })
  expect(parseRollout(line).activity).toBe('ran a python3 script')
})

describe('the wire', () => {
  const t: Transfer = { id: 'a', dir: 'to-codex', label: 'T1 packet', startAt: 0 }
  const at = (ms: number, x: Transfer = t) => wireFrame(40, x, ms)!.map(s => s.text).join('')
  test('a packet crosses left to right and keeps the track width', async () => {
    expect(at(0).indexOf('▶')).toBe(0)
    expect(at(TRANSFER_MS / 2).indexOf('▶')).toBeGreaterThan(5)
    expect(at(TRANSFER_MS).endsWith('▶')).toBe(true)
    for (const ms of [0, 400, 800, 1200, TRANSFER_MS]) expect(at(ms).length).toBe(40)
  })
  test('a reply crosses right to left', async () => {
    const back: Transfer = { ...t, dir: 'to-claude' }
    expect(at(0, back).endsWith('◀')).toBe(true)
    expect(at(TRANSFER_MS, back).startsWith('◀')).toBe(true)
  })
  test('packets queue one behind another', async () => {
    expect(nextSlot([t], 100)).toBe(TRANSFER_MS + 250)
    expect(nextSlot([], 100)).toBe(100)
  })
  test('text types in', async () => {
    expect(reveal('hello world', 0, 0)).toBe('h')
    expect(reveal('hello world', 0, 50)).toBe('hello')
    expect(reveal('hello world', 0, 5000)).toBe('hello world')
  })
})

const TANDEM = `# TANDEM — Triage\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| T1 Gather open work | Codex | Claude | triage |\n| T2 Rank and reply | Claude | Codex | ship |\n## Swap log\nNone.\n`

const world = (on: On, files: Record<string, string>) => {
  const day = new Date()
  const folder = `/Users/me/.codex/sessions/${day.getFullYear()}/${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`
  on('env.get', () => ({ value: '/Users/me' }) as never)
  on('session.cwd', () => ({ value: DIR }))
  on('session.root', () => ({ value: DIR }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.stat', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: Date.now(), isLink: false } }
  })
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path]! }) as never)
  // `tail -c +N file`, `tail -c N file` and `head -c N file` over the in-memory files, byte-exact.
  on('process.run', ($, e) => {
    // readBytes: ['/bin/sh', '-c', 'tail -c +"$1" "$2" | head -c "$3"', 'sh', from1, path, length]
    const [, , , , from1 = '1', path = '', length = '0'] = e.argv
    const bytes = new TextEncoder().encode(files[path] ?? '')
    const cut = bytes.slice(Number(from1) - 1, Number(from1) - 1 + Number(length))
    const stdout = new TextDecoder().decode(cut)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('fs.list', ($, e) =>
    (e.path === folder
      ? { value: Object.keys(files).filter(f => f.startsWith(folder)).map(f => ({ name: f.slice(folder.length + 1), kind: 'file', size: files[f]!.length, mtimeMs: Date.now(), isLink: false })) }
      : { value: [] }) as never,
  )
  return `${folder}/rollout-2026-test.jsonl`
}

const PANE = { title: 'Tandem', isFocused: false, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

test('a Codex session in the tandem folder fills the Codex lane and sends a packet', async ($, on) => {
  const files: Record<string, string> = { [`${DIR}/TANDEM.md`]: TANDEM }
  const log = world(on, files)
  files[log] = rollout()
  await $.command.run({ command: 'tandem', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface, component: 'Pane', requestId: 'tandem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /T1 · lead/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /read TANDEM\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ T1 packet · lead ▶/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a finished Codex session sends its file and result back to Claude', async ($, on) => {
  const files: Record<string, string> = { [`${DIR}/TANDEM.md`]: TANDEM }
  const log = world(on, files)
  files[log] = rollout()
  await $.command.run({ command: 'tandem', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
  await ui.press({ key: 'refresh' })
  files[log] = rollout({ wrote: true, done: true })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /✓ T1 done · AGREE\. T1 acceptance met/ })).toBeDefined()
  await ui.unmount()
})

test("Claude's stream shows in its lane as it arrives", async ($, on) => {
  const files: Record<string, string> = { [`${DIR}/TANDEM.md`]: TANDEM }
  world(on, files)
  const clock = mock.clock(on)
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'weighing the split' }
    yield { kind: 'text', index: 1, text: 'Ranking the five most pressing items now' }
    return { turnId: 't1', index: 0, answer: 'Ranking the five most pressing items now', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.command.run({ command: 'tandem', args: '' } as never)
  const stepped = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)
  for await (const _ of stepped) {
    // drain
  }
  await clock.advance(200)
  const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
  expect(await ui.find({ type: 'Text', text: /Ranking the five most pressing/ })).toBeDefined()
  await ui.unmount()
})
