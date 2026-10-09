import { describe, expect, test } from 'claude-code/testing'

import type { LiveRun } from '../types'
import { layout, newWorld, render, step, toRasterCells, toSvg } from './game'
import type { Inputs } from './game'
import { parseTandem } from './parse'

const DIR = '/Users/me/triage'
const TANDEM = `# TANDEM — Triage\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| T1 Gather | Codex | Claude | triage |\n| T2 Rank | Claude | Codex | ship |\n`
const doc = parseTandem(TANDEM)
const base: Inputs = { doc, claude: { mode: 'thinking', text: '', since: 0 }, runs: [], codex: [], transfers: [] }

describe('the arcade world', () => {
  test('a subagent splits a clone off Claude and it merges back when done', async () => {
    const lay = layout(100, 40, doc)
    const w = newWorld()
    const run: LiveRun = { id: 's1', side: 'claude', label: 'subagent', startedAt: 0 }
    let t = 1000
    step(w, lay, base, t)
    step(w, lay, { ...base, runs: [run] }, (t += 100))
    expect(w.actors.has('claude:s1')).toBe(true)
    expect(w.poofs.length).toBe(1)
    for (let i = 0; i < 40; i++) step(w, lay, { ...base, runs: [{ ...run, endedAt: t }] }, (t += 100))
    expect(w.actors.has('claude:s1')).toBe(false)
  })

  test('a second Codex run is a second Codex', async () => {
    const lay = layout(100, 40, doc)
    const w = newWorld()
    const run = (id: string, part: string) => ({ id, file: id, cwd: DIR, part, startedAt: 0, lastEventAt: 0, wrote: [], mtimeMs: 0 })
    step(w, lay, { ...base, codex: [run('a', 'T1'), run('b', 'T1')] }, 1000)
    expect([...w.actors.values()].filter(a => a.kind === 'codex').length).toBe(2)
  })

  test('frames encode for both surfaces at the canvas size', async () => {
    const lay = layout(64, 30, doc)
    const w = newWorld()
    step(w, lay, base, 1000)
    const c = render(w, lay, base, 1000)
    const cells = toRasterCells(c)
    expect([cells.columns, cells.rows]).toEqual([64, 15])
    expect(cells.cells.length).toBe(Math.ceil((64 * 15 * 12) / 3) * 4)
    expect(toSvg(c)).toMatch(/^<svg [^>]*viewBox="0 0 64 30"/)
  })
})

test('the arcade pane draws pixels on the terminal and the desktop', async ($, on) => {
  on('env.get', () => ({ value: '/Users/me' }) as never)
  on('session.cwd', () => ({ value: DIR }))
  on('session.root', () => ({ value: DIR }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('fs.stat', ($, e) => (e.path === `${DIR}/TANDEM.md` ? { value: { kind: 'file', size: TANDEM.length, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', ($, e) => (e.path === `${DIR}/TANDEM.md` ? { value: TANDEM } : { deny: 'ENOENT' }) as never)
  await $.command.run({ command: 'tandem', args: 'arcade' } as never)
  const props = { title: 'Tandem Arcade', isFocused: false, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  const term = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem-arcade', props })
  expect(await term.find({ type: 'Raster' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Claude is thinking|Claude is on a break/ })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ plugin: 'tandem-split', surface: 'desktop', component: 'Pane', requestId: 'tandem-arcade', props })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
})
