export type Side = 'claude' | 'codex' | 'both' | 'none'

export type PartStatus = 'assigned' | 'handed-off' | 'delivered' | 'in-review' | 'accepted' | 'blocked'

export type TandemPart = {
  id: string
  name: string
  lead: Side
  leadLabel: string
  second: Side
  status: PartStatus
  notes: number
}

export type TandemDoc = {
  title: string
  parts: TandemPart[]
  agreed: boolean
  contested: boolean
  swaps: string[]
  mtimeMs: number
}

/** A Claude-side run this session started: a subagent or a headless `claude -p`. */
export type LiveRun = {
  id: string
  side: 'claude' | 'codex'
  label: string
  startedAt: number
  taskId?: string
  endedAt?: number
  isError?: boolean
}

/** A Codex session, read from its rollout log under ~/.codex/sessions. */
export type CodexRun = {
  id: string
  file: string
  cwd: string
  part?: string
  role?: 'LEAD' | 'SECOND'
  startedAt: number
  lastEventAt: number
  endedAt?: number
  isError?: boolean
  isStalled?: boolean
  commentary?: string
  /** When this pane first saw the current commentary: where its typing starts. */
  commentarySeenAt?: number
  activity?: string
  wrote: string[]
  final?: string
  mtimeMs: number
}

/** A packet on the wire between the lanes. */
export type Transfer = {
  id: string
  dir: 'to-codex' | 'to-claude'
  label: string
  startAt: number
  isError?: boolean
}

/** What the main Claude loop is doing right now, from its response stream. */
export type ClaudeLive = {
  mode: 'idle' | 'thinking' | 'writing' | 'tool'
  text: string
  since: number
  tool?: string
  arg?: string
  summary?: string
}

export type PartChange = {
  id: string
  kind: 'new' | 'status'
  from?: PartStatus
  to?: PartStatus
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'tandem-split': {
      file: string | null
      doc: TandemDoc | null
      runs: LiveRun[]
      codex: CodexRun[]
      transfers: Transfer[]
      claude: ClaudeLive
      changes: PartChange[]
      now: number
      /** Tandem Arcade's frame counter: what redraws its SVG on surfaces with no Raster. */
      arcade: number
    }
  }
}
