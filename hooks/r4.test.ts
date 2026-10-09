// Regressions for the R3 review's findings (.tandem/R3-REVIEW.md).
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SVG_LIMIT, layout, newWorld, render, step, toSvg } from './game'
import type { Inputs } from './game'
import { parseRollout, parseTandem, salvageLine } from './parse'

const DIR = '/Users/me/triage'
const iso = (ms: number) => new Date(ms).toISOString()
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const ev = (t: number, payload: unknown) => line({ timestamp: iso(t), type: 'event_msg', payload })
const item = (t: number, it: unknown) => ev(t, { type: 'item_completed', item: it })
const TANDEM = `# TANDEM — Triage\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| T1 Gather | Codex | Claude | triage |\n| T2 Rank | Claude | Codex | ship |\n`
const PANE = { title: 'Tandem', isFocused: false, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const folder = () => {
  const d = new Date()
  return `/Users/me/.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

const world = (on: On, files: Record<string, string>) => {
  const enc = new TextEncoder()
  const fresh = Date.now()
  on('env.get', () => ({ value: '/Users/me' }) as never)
  on('session.cwd', () => ({ value: DIR }))
  on('session.root', () => ({ value: DIR }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in files }) as never)
  on('fs.stat', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: enc.encode(files[e.path]!).length, mtimeMs: fresh, isLink: false } }) as never)
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path]! }) as never)
  on('fs.list', ($, e) => ({ value: Object.keys(files).filter(f => f.startsWith(`${e.path}/`)).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: enc.encode(files[f]!).length, mtimeMs: fresh, isLink: false })) }) as never)
  // Byte-exact `tail -c +N | head -c M`, capped as the process noun caps stdout.
  on('process.run', ($, e) => {
    const [, , , , from1 = '1', path = '', length = '0'] = e.argv
    const bytes = enc.encode(files[path] ?? '').slice(Number(from1) - 1, Number(from1) - 1 + Math.min(Number(length), 4 * 1024 * 1024))
    return { value: { exitCode: 0, stdout: new TextDecoder().decode(bytes), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
}

describe('R3-1 desktop SVG stays under its limit', () => {
  test('the largest desktop canvas encodes under SvgProps.source', async () => {
    const doc = parseTandem(TANDEM)
    const inp: Inputs = { doc, claude: { mode: 'idle', text: '', since: 0 }, runs: [], codex: [], transfers: [] }
    const lay = layout(160, 64, doc)
    const w = newWorld()
    step(w, lay, inp, 1000)
    expect(toSvg(render(w, lay, inp, 1000)).length).toBeLessThan(SVG_LIMIT)
  })
})

describe('R3-2 large logs drain to their end', () => {
  test('a 7 MB log with a 3.5 MB file change reaches completion and keeps the file', async ($, on) => {
    const t = Date.now()
    const big = 'x'.repeat(3_600_000)
    const log = `${folder()}/rollout-huge.jsonl`
    const text =
      line({ timestamp: iso(t), type: 'session_meta', payload: { id: 'h', timestamp: iso(t), cwd: DIR } }) +
      item(t, { type: 'UserMessage', content: [{ type: 'text', text: 'You are LEAD on part T1 in ./TANDEM.md.' }] }) +
      item(t + 1, { type: 'FileChange', id: 'fc', changes: { [`${DIR}/HUGE.md`]: { type: 'add', content: big } } }) +
      ev(t + 2, { type: 'token_count', pad: 'y'.repeat(3_000_000) }) +
      ev(t + 3, { type: 'task_complete', last_agent_message: 'All done here.' })
    world(on, { [`${DIR}/TANDEM.md`]: TANDEM, [log]: text })
    await $.command.run({ command: 'tandem', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /✓ T1 done · All done here\./ })).toBeDefined()
    await ui.unmount()
  })

  test('a giant file-change line still yields its path', async () => {
    const start = `{"timestamp":"x","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"a","changes":{"/p/q/BIG.md":{"type":"add","content":"zzzz`
    expect(salvageLine(parseRollout(''), start).wrote).toEqual(['BIG.md'])
  })
})

describe('R3-3 a fast notification is not lost', () => {
  test('a completion appended before the run records its id still ends it', async ($, on) => {
    world(on, { [`${DIR}/TANDEM.md`]: TANDEM })
    on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'agent-fast' } }) as never)
    await $.command.run({ command: 'tandem', args: '' } as never)
    const call = $.tool.call({ tool: 'Agent', description: 'quick one', prompt: 'p', subagent_type: 'general-purpose' } as never)
    await call
    // No settling in between: the notification races the run's bookkeeping.
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>agent-fast</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>' }] } } as never)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /subagent · quick one/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('R3-4 R3-6 arcade timer and surfaces', () => {
  test('both surfaces animate at once, and the clock stops once neither is drawn (no close event)', async ($, on) => {
    world(on, { [`${DIR}/TANDEM.md`]: TANDEM })
    const clock = mock.clock(on)
    await clock.set(Date.now())
    let blits = 0
    let isMounted = true
    // As the engine does: a blit to a Raster no longer mounted is refused.
    on('ui.blit', () => {
      blits += 1
      return (isMounted ? { value: {} } : { value: { deny: 'not mounted' } }) as never
    })
    await $.command.run({ command: 'tandem', args: 'arcade' } as never)
    const props = { ...PANE, title: 'Tandem Arcade', bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 } }
    const term = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem-arcade', props })
    const desk = await $.ui.mount({ plugin: 'tandem-split', surface: 'desktop', component: 'Pane', requestId: 'tandem-arcade', props })
    await clock.advance(2000)
    expect(blits).toBeGreaterThan(0)
    expect(await desk.find({ type: 'Svg' })).toBeDefined()
    await term.unmount()
    await desk.unmount()
    isMounted = false
    await clock.advance(4000) // the terminal's refused blit and the desktop's 3 s without a draw retire both views
    const after = blits
    await clock.advance(3000)
    expect(blits).toBe(after)
  })
})

describe('R3-5 and R1-7 status in document order', () => {
  test('acceptance before a re-assignment does not carry over', async () => {
    const t = `# X\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P1 a | Codex | Claude | r |\n### P1 accepted\n## Parts (round 2)\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P1 a again | Claude | Codex | r |\n`
    expect(parseTandem(t).parts[0]?.status).toBe('assigned')
  })
  test('a wrap-up accepts only parts that existed by then', async () => {
    const t = `# X\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P1 a | Codex | Claude | r |\n### Final acceptance — all parts\n## Parts (later)\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P2 b | Claude | Codex | r |\n`
    expect(parseTandem(t).parts.map(p => p.status)).toEqual(['accepted', 'assigned'])
  })
  test('LEAD and accepted in one heading reads as accepted', async () => {
    const t = `# X\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P1 a | Codex | Claude | r |\n### P1 — LEAD: codex — accepted\n`
    expect(parseTandem(t).parts[0]?.status).toBe('accepted')
  })
})

describe('R3-7 a promoted Codex run keeps no stray clone', () => {
  test('when the first run ends, the second run\'s clone merges into the original', async () => {
    const doc = parseTandem(TANDEM)
    const lay = layout(100, 40, doc)
    const w = newWorld()
    const run = (id: string) => ({ id, file: id, cwd: DIR, part: 'T1', startedAt: 0, lastEventAt: 0, wrote: [], mtimeMs: 0 })
    const inp = (codex: Inputs['codex']): Inputs => ({ doc, claude: { mode: 'idle', text: '', since: 0 }, runs: [], codex, transfers: [] })
    let t = 1000
    step(w, lay, inp([run('a'), run('b')]), t)
    expect(w.actors.has('codex:b')).toBe(true)
    for (let i = 0; i < 60; i++) step(w, lay, inp([{ ...run('a'), endedAt: 1 }, run('b')]), (t += 100))
    expect([...w.actors.values()].filter(a => a.kind === 'codex').length).toBe(1)
  })
})

describe('R1-9 residual: switching TANDEM.md mid-poll', () => {
  test("a read for /A that finishes after switching to /B never shows in B's pane", async ($, on) => {
    const t = Date.now()
    const A = '/Users/me/a'
    const B = '/Users/me/b'
    const log = `${folder()}/rollout-a.jsonl`
    const files: Record<string, string> = {
      [`${A}/TANDEM.md`]: TANDEM,
      [`${B}/TANDEM.md`]: TANDEM.replace('Triage', 'Bee'),
      [log]: line({ timestamp: iso(t), type: 'session_meta', payload: { id: 'a', timestamp: iso(t), cwd: A } }) + item(t, { type: 'UserMessage', content: [{ type: 'text', text: 'You are LEAD on part ZA1 in ./TANDEM.md.' }] }),
    }
    let release: () => void = () => undefined
    const gate = new Promise<void>(r => (release = r))
    const enc = new TextEncoder()
    on('env.get', () => ({ value: '/Users/me' }) as never)
    on('session.cwd', () => ({ value: '/Users/me' }))
    on('session.root', () => ({ value: '/Users/me' }))
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isOpen: true } }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('ui.status', () => ({ value: undefined }) as never)
    on('fs.exists', ($, e) => ({ value: e.path in files }) as never)
    on('fs.stat', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: enc.encode(files[e.path]!).length, mtimeMs: t, isLink: false } }) as never)
    on('fs.list', ($, e) => ({ value: Object.keys(files).filter(f => f.startsWith(`${e.path}/`)).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: enc.encode(files[f]!).length, mtimeMs: t, isLink: false })) }) as never)
    on('fs.read', async ($, e) => {
      if (e.path === log) await gate // the rollout read hangs until the switch is done
      return (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path]! }) as never
    })
    await $.command.run({ command: 'tandem', args: A } as never)
    const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: PANE })
    const pending = ui.press({ key: 'refresh' })
    await $.command.run({ command: 'tandem', args: B } as never)
    release()
    await pending
    expect(await ui.find({ type: 'Text', text: /TANDEM — Bee/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ZA1/ })).toBeUndefined()
    await ui.unmount()
  })
})
