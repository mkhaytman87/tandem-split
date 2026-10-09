import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const DOC = `# TANDEM — Demo\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| P1 Audit the repo | Codex | Claude | audit |\n| P2 Land the fix | Claude | Codex | ship |\n## Swap log\nNone.\n`

const disk = (on: On, files: Record<string, string>, cwd = '/proj', withOpen = true) => {
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  if (withOpen) on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('fs.stat', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
}

const pane = (bodyColumns: number) => ({
  title: 'Tandem',
  isFocused: false,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
})

test('pane draws both lanes with their parts on every surface', async ($, on) => {
  disk(on, { '/proj/TANDEM.md': DOC })
  await $.command.run({ command: 'tandem', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [100, 40]) {
      const ui = await $.ui.mount({ plugin: 'tandem-split', surface, component: 'Pane', requestId: 'tandem', props: pane(bodyColumns) })
      expect(await ui.find({ type: 'Text', text: 'CLAUDE' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'CODEX' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /P1 {2}Audit the repo/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /5 Work/ })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('pane without a TANDEM.md offers to look again', async ($, on) => {
  disk(on, {})
  const ui = await $.ui.mount({ plugin: 'tandem-split', surface: 'terminal', component: 'Pane', requestId: 'tandem', props: pane(80) })
  expect(await ui.find({ type: 'Text', text: /No TANDEM.md/ })).toBeDefined()
  await ui.unmount()
})

test('a job instead of a path is submitted as a tandem prompt', async ($, on) => {
  disk(on, {})
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { drop: 'captured by the test' } as never
  })
  const out = await $.command.run({ command: 'tandem', args: 'which open tasks should ship this week?' } as never)
  await clock.advance(200)
  expect(sent).toEqual(['Use the codex-claude-tandem skill for this job: which open tasks should ship this week?'])
  expect(JSON.stringify(out)).toContain('Starting a tandem run')
})

test('~ paths and folders resolve to their TANDEM.md', async ($, on) => {
  disk(on, { '/Users/me/triage/TANDEM.md': DOC }, '/Users/me')
  const out = await $.command.run({ command: 'tandem', args: '~/triage' } as never)
  expect(JSON.stringify(out)).toContain('/Users/me/triage/TANDEM.md')
})

test('writing a TANDEM.md opens the pane once', async ($, on) => {
  disk(on, { '/proj/TANDEM.md': DOC }, '/proj', false)
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isOpen: true } } as never
  })
  on('tool.call', () => ({ result: { type: 'create' } }) as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/TANDEM.md', content: DOC } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/proj/TANDEM.md', old_string: 'a', new_string: 'b' } as never)
  expect(opened).toEqual(['tandem'])
})
