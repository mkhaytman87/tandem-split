// Regressions for the R1 review's findings (.tandem/R1-REVIEW.md), one test or more each.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Transfer } from '../types'
import { HOLD_MS, TRANSFER_MS, activeTransfer } from './anim'
import { parseRollout, parseTandem, taskOutcome } from './parse'

const DIR = '/Users/me/triage'
const iso = (ms: number) => new Date(ms).toISOString()
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const meta = (t: number) => line({ timestamp: iso(t), type: 'session_meta', payload: { id: 'sess-big', timestamp: iso(t), cwd: DIR } })
const ev = (t: number, payload: unknown) => line({ timestamp: iso(t), type: 'event_msg', payload })
const item = (t: number, it: unknown) => ev(t, { type: 'item_completed', item: it })
const handoff = (t: number, part = 'T1') => item(t, { type: 'UserMessage', content: [{ type: 'text', text: `You are LEAD on part ${part} in ./TANDEM.md.` }] })

const TANDEM = `# TANDEM — Triage\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| T1 Gather | Codex | Claude | triage |\n| T2 Rank | Claude | Codex | ship |\n## Swap log\nNone.\n`
const PANE = { title: 'Tandem', isFocused: false, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

const folder = () => {
  const d = new Date()
  return `/Users/me/.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/** An in-memory machine: files with byte-exact head/tail, mtimes bumped on write. */
const world = (on: On, files: Record<string, string>) => {
  const mtimes: Record<string, number> = {}
  let lists = 0
  const mtime = (p: string) => (mtimes[p] ??= Date.now())
  on('env.get', () => ({ value: '/Users/me' }) as never)
  on('session.cwd', () => ({ value: DIR }))
  on('session.root', () => ({ value: DIR }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in files }) as never)
  on('fs.stat', ($, e) => {
    const text = files[e.path]
    return (text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: mtime(e.path), isLink: false } }) as never
  })
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path]! }) as never)
  on('fs.list', ($, e) => ({
    value: (lists++, Object.keys(files))
      .filter(f => f.startsWith(`${e.path}/`))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: new TextEncoder().encode(files[f]!).length, mtimeMs: mtime(f), isLink: false })),
  }) as never)
  on('process.run', ($, e) => {
    // readBytes: ['/bin/sh', '-c', 'tail -c +"$1" "$2" | head -c "$3"', 'sh', from1, path, length]
    const [, , , , from1 = '1', path = '', length = '0'] = e.argv
    const bytes = new TextEncoder().encode(files[path] ?? '')
    const cut = bytes.slice(Number(from1) - 1, Number(from1) - 1 + Number(length))
    return { value: { exitCode: 0, stdout: new TextDecoder().decode(cut), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  return {
    lists: () => lists,
    write(path: string, text: string) {
      files[path] = text
      mtimes[path] = (mtimes[path] ?? Date.now()) + 1000
    },
  }
}

describe('#1 the frame outlives a slow first chunk', () => {
  test('a chunk arriving after the frame went idle still reaches the lane', async ($, on) => {
    world(on, { [`${DIR}/TANDEM.md`]: TANDEM })
    const clock = mock.clock(on)
    await clock.set(Date.now())
    let release: () => void = () => undefined
    const gate = new Promise<void>(r => (release = r))
    on('turn.step', async function* () {
      await gate
      yield { kind: 'text', index: 0, text: 'Late but live' }
      return { turnId: 't', index: 0, answer: 'Late but live', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    await $.command.run({ command: 'tandem', args: '' } as never)
    const drained = (async () => {
      for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)) {
        // drain
      }
    })()
    await clock.advance(500) // the frame has looked and found nothing moving
    release()
    await drained
    await clock.advance(200)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    expect(await ui.find({ type: 'Text', text: /Late but live/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('#2 large logs keep their hand-off and history', () => {
  test('a hand-off past the old 64 KB head is found, and appended files fold in', async ($, on) => {
    const t = Date.now()
    const filler = Array.from({ length: 1400 }, (_, i) => ev(t + 1, { type: 'token_count', info: { pad: 'x'.repeat(100), i } })).join('')
    const log = `${folder()}/rollout-big.jsonl`
    const files: Record<string, string> = { [`${DIR}/TANDEM.md`]: TANDEM, [log]: meta(t) + ev(t, { type: 'task_started' }) + filler + handoff(t + 2) + filler }
    expect(new TextEncoder().encode(files[log]!).length).toBeGreaterThan(64 * 1024)
    const fs = world(on, files)
    await $.command.run({ command: 'tandem', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /T1 · lead/ })).toBeDefined()
    fs.write(log, files[log]! + item(t + 3, { type: 'FileChange', changes: { [`${DIR}/T1-FINDINGS.md`]: {} } }) + ev(t + 4, { type: 'task_complete', last_agent_message: 'Done. Findings written.' }))
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /✓ T1 done/ })).toBeDefined()
    await ui.unmount()
  })

  test('folding increments equals parsing the whole log', async () => {
    const t = Date.now()
    const a = meta(t) + handoff(t + 1) + item(t + 2, { type: 'FileChange', changes: { '/x/A.md': {} } })
    const b = item(t + 3, { type: 'FileChange', changes: { '/x/B.md': {} } }) + ev(t + 4, { type: 'task_complete', last_agent_message: 'ok' })
    const whole = parseRollout(a + b)
    const folded = parseRollout(b, parseRollout(a))
    expect([folded.part, folded.wrote, folded.done]).toEqual([whole.part, whole.wrote, whole.done])
    expect(folded.wrote).toEqual(['A.md', 'B.md'])
  })
})

describe('#3 overlapping refreshes send one packet', () => {
  test('two refreshes at once leave no duplicate on the wire', async ($, on) => {
    const t = Date.now()
    const log = `${folder()}/rollout-x.jsonl`
    world(on, { [`${DIR}/TANDEM.md`]: TANDEM, [log]: meta(t) + handoff(t + 1) })
    await $.command.run({ command: 'tandem', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    await Promise.all([ui.press({ key: 'refresh' }), ui.press({ key: 'refresh' })])
    expect(await ui.find({ type: 'Text', text: /\+\d/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('#5 background subagents stay running until notified', () => {
  test('an async_launched Agent runs until its task notification', async ($, on) => {
    world(on, { [`${DIR}/TANDEM.md`]: TANDEM })
    on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'agent-7' } }) as never)
    await $.command.run({ command: 'tandem', args: '' } as never)
    await $.tool.call({ tool: 'Agent', description: 'dig the logs', prompt: 'p', subagent_type: 'general-purpose' } as never)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    expect(await ui.find({ type: 'Text', text: /subagent · dig the logs/ })).toBeDefined()
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>agent-7</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n</task-notification>' }] },
    } as never)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /subagent · dig the logs/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('#6 #7 TANDEM.md parsing', () => {
  test('parts from every Parts table, the latest row per id winning', async () => {
    const doc = parseTandem(`# X\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P1 a | Codex | Claude | r |\n## Later\ntext\n## Parts (round 2)\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P2 b | Claude | Codex | r |\n| P1 a | Claude | Codex | r |\n`)
    expect(doc.parts.map(p => [p.id, p.lead])).toEqual([['P1', 'claude'], ['P2', 'claude']])
  })
  test('a heading naming no part changes no part; negation is not acceptance', async () => {
    const base = `# X\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P1 a | Codex | Claude | r |\n| P2 b | Claude | Codex | r |\n`
    expect(parseTandem(`${base}### Review R1 — not accepted yet\n`).parts.map(p => p.status)).toEqual(['assigned', 'assigned'])
    expect(parseTandem(`${base}### P1 review — not accepted yet\n`).parts[0]?.status).toBe('assigned')
    expect(parseTandem(`${base}### P1 accepted\n### P1 — LEAD: codex\n`).parts[0]?.status).toBe('accepted')
    expect(parseTandem(`${base}### Final acceptance — Oct 8\n`).parts.map(p => p.status)).toEqual(['accepted', 'accepted'])
  })
})

describe('#8 a TANDEM.md that appears later is found', () => {
  test('the poll picks up a file created after the session started', async ($, on) => {
    const files: Record<string, string> = {}
    const fs = world(on, files)
    const clock = mock.clock(on)
    await clock.set(Date.now())
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', () => ({ cwd: DIR }) as never)
    await $.session.start({ cwd: DIR, surface: 'terminal' } as never)
    fs.write(`${DIR}/TANDEM.md`, TANDEM)
    await clock.advance(6000)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    expect(await ui.find({ type: 'Text', text: /TANDEM — Triage/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('#9 #10 which Codex sessions count', () => {
  test('a session in another folder never shows; a home-folder session is not a repo root', async ($, on) => {
    const t = Date.now()
    world(on, {
      [`${DIR}/TANDEM.md`]: TANDEM,
      [`${folder()}/rollout-other.jsonl`]: line({ timestamp: iso(t), type: 'session_meta', payload: { id: 'o', timestamp: iso(t), cwd: '/Users/me/elsewhere' } }) + handoff(t, 'Z9'),
      [`${folder()}/rollout-home.jsonl`]: line({ timestamp: iso(t), type: 'session_meta', payload: { id: 'h', timestamp: iso(t), cwd: '/Users/me' } }) + handoff(t, 'Z8'),
    })
    await $.command.run({ command: 'tandem', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Z9|Z8/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('#11 aborted Codex turns', () => {
  test('an abort ends the turn; a new turn forgets the old answer', async () => {
    const t = Date.now()
    const first = meta(t) + ev(t, { type: 'task_started' }) + ev(t + 1, { type: 'task_complete', last_agent_message: 'old success' })
    const aborted = parseRollout(first + ev(t + 2, { type: 'task_started' }) + ev(t + 3, { type: 'turn_aborted' }))
    expect([aborted.done, aborted.isError, aborted.final]).toEqual([true, true, undefined])
  })
})

describe('#12 task notifications match exactly', () => {
  const note = (id: string, status: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>x</summary>\n</task-notification>`
  test('task-1234 does not end task-123', async () => {
    expect(taskOutcome(note('task-1234', 'completed'), ['task-123'])).toBeUndefined()
    expect(taskOutcome(note('task-123', 'completed'), ['task-123'])).toEqual({ isError: false })
  })
  test('prose that mentions the id is not a notification', async () => {
    expect(taskOutcome('task-123 is still pending; the earlier one failed', ['task-123'])).toBeUndefined()
  })
})

describe('#13 queued packets', () => {
  test('a packet crossing wins over one resting at its end', async () => {
    const a: Transfer = { id: 'a', dir: 'to-codex', label: 'first', startAt: 0 }
    const b: Transfer = { id: 'b', dir: 'to-claude', label: 'second', startAt: TRANSFER_MS + 250 }
    const at = TRANSFER_MS + 300
    expect(at).toBeLessThan(TRANSFER_MS + HOLD_MS)
    expect(activeTransfer([a, b], at)?.id).toBe('b')
  })
})

describe('#14 narrow widths', () => {
  test('the idle wire stays within the pane', async ($, on) => {
    const t = Date.now()
    const long = 'A-REALLY-LONG-FINDINGS-FILE-NAME-THAT-GOES-ON-AND-ON.md'
    world(on, {
      [`${DIR}/TANDEM.md`]: TANDEM,
      [`${folder()}/rollout-w.jsonl`]: meta(t) + handoff(t + 1) + item(t + 2, { type: 'FileChange', changes: { [`${DIR}/${long}`]: {} } }) + ev(t + 3, { type: 'task_complete', last_agent_message: 'ok' }),
    })
    await $.command.run({ command: 'tandem', args: '' } as never)
    for (const bodyColumns of [30, 50]) {
      const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: { ...PANE, bodyColumns } })
      await ui.press({ key: 'refresh' })
      const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '')
      const wire = texts.find(x => x.includes('─') && !x.includes('▶') && !x.includes('◀'))
      if (wire !== undefined) expect(wire.length).toBeLessThanOrEqual(bodyColumns)
      await ui.unmount()
    }
  })
})

describe('#4 nothing runs without a tandem', () => {
  test('with no TANDEM.md the poll never scans Codex logs', async ($, on) => {
    const fs = world(on, {})
    const clock = mock.clock(on)
    await clock.set(Date.now())
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', () => ({ cwd: DIR }) as never)
    await $.session.start({ cwd: DIR, surface: 'terminal' } as never)
    await clock.advance(12_000)
    expect(fs.lists()).toBe(0)
  })
})
