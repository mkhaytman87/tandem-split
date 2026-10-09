import { describe, expect, test } from 'claude-code/testing'

import { codexRun, parseTandem, taskOutcome, workflow } from './parse'

const DOC = `# TANDEM — Demo project

## Parts

| Part | LEAD | SECOND | Routing row |
|---|---|---|---|
| P1 Parametric CAD model | Codex (gpt-6-astra) | Claude | 3D assets |
| P2 Design review | Claude | — | review |

### P1 — LEAD: codex (gpt-6-astra)  SECOND: claude
Goal: build it.

### P1 delivery note — 2026-10-06
AGREE on the existing split; no lead change.

### P2 review — Claude, 2026-10-06 (round 1)

## Swap log

- 2026-10-07 P1 codex → claude: looped 3 times.
`

describe('parseTandem', () => {
  test('reads parts, leads and status from headings', async () => {
    const doc = parseTandem(DOC)
    expect(doc.title).toBe('TANDEM — Demo project')
    expect(doc.parts.map(p => [p.id, p.lead, p.second, p.status])).toEqual([
      ['P1', 'codex', 'claude', 'delivered'],
      ['P2', 'claude', 'none', 'in-review'],
    ])
    expect(doc.agreed).toBe(true)
    expect(doc.swaps.length).toBe(1)
  })

  test('id — name parts and an unscoped final acceptance', async () => {
    const doc = parseTandem(`# X\n## Parts\n| Part | LEAD | SECOND | Row |\n|---|---|---|---|\n| dashboard-design — simplify | Claude | Codex | ui |\n### Final acceptance — September 11\n## Swap log\nNone.\n`)
    expect(doc.parts[0]?.id).toBe('dashboard-design')
    expect(doc.parts[0]?.status).toBe('accepted')
    expect(doc.swaps).toEqual([])
  })

  test('the handoff prompt template is not an agreement', async () => {
    expect(parseTandem('# X\nStep 1: reply AGREE or CONTEST on the split').agreed).toBe(false)
  })
})

describe('workflow', () => {
  test('current step is the first unfinished one', async () => {
    const steps = workflow(parseTandem(DOC), false)
    expect(steps.map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'current', 'done'])
    expect(workflow(null, false)[0]?.state).toBe('current')
  })

  test('codex commands are labelled with model and sandbox', async () => {
    expect(codexRun('codex exec -m gpt-6.1-sol --sandbox read-only "x" < /dev/null')).toBe('codex exec · gpt-6.1-sol · read-only')
    expect(codexRun('ls codex')).toBeUndefined()
  })
})

describe('taskOutcome', () => {
  const note = (status: string, extra = '') =>
    `<task-notification><task-id>b8f2k1</task-id><tool-use-id>toolu_01AB</tool-use-id><status>${status}</status><summary>Background command finished${extra}</summary></task-notification>`
  test('matches by task id or tool use id and reads the status', async () => {
    expect(taskOutcome(note('completed'), ['b8f2k1', 'x'])).toEqual({ isError: false })
    expect(taskOutcome(note('failed'), ['nope', 'toolu_01AB'])).toEqual({ isError: true })
    expect(taskOutcome(note('completed', ' (exit code 2)'), ['b8f2k1'])).toEqual({ isError: true })
  })
  test('ignores other tasks and running updates', async () => {
    expect(taskOutcome(note('completed'), ['zzz'])).toBeUndefined()
    expect(taskOutcome(note('running'), ['b8f2k1'])).toBeUndefined()
  })
})
