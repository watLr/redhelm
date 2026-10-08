export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

export type Agent = {
  id: string
  name: string
  type: string
  description: string
  status: AgentStatus
  model?: string
  effort?: string
  /** What it is doing right now: the last tool call, short. */
  activity?: string
  /** The kinds of its last few tool calls, newest last; its phase is read from them. */
  recent: Phase[]
  /** Files it changed, newest last, relative to the session root. */
  files: string[]
  edits: number
  /** Commands that came back as errors. */
  fails: number
  /** Tokens in its context at the last model request. */
  context: number
  startedAt: number
  endedAt?: number
  /** First meaningful line of its final answer. */
  answer?: string
}

export type Phase = 'exploring' | 'building' | 'checking' | 'delegating'

export type NoteKind = 'spawn' | 'done' | 'fail' | 'ask' | 'reply' | 'guard'

export type Note = { at: number; kind: NoteKind; text: string; agentId?: string }

/** A message an agent addressed to the lead (you). */
export type Message = { id: string; agentId: string; text: string; at: number }

export type StageRow = { id: string; stages: Record<string, string>; note: string; at: number }

export type Lane = { id: string; title: string; done: number; total: number; active?: string; agent?: string }

export type Run = { name: string; status: string; next?: string; open: number }

export type Workspace = {
  dir: string
  name: string
  /** REDStudio: standards count and the newest one's title. */
  studio?: { standards: number; latest?: string }
  /** status-board: stage names and the rows still open. */
  board?: { stages: string[]; rows: StageRow[]; total: number }
  /** Lane board: lanes.json and per-lane events. */
  lanes?: Lane[]
  /** REDManager runs, newest first. */
  runs?: Run[]
}

/** One Claude Code setting REDhelm would change, shown on the setup card. */
export type SetupItem = { key: string; label: string; value: string | boolean }

/** This session's model requests: what actually answered, main thread and agents together. */
export type Usage = Record<string, { requests: number; output: number; agents: number }>

/** Where the person wants REDhelm: the right dock (inline when the layout cannot dock) or the band above the prompt. */
export type Placement = 'right' | 'bottom'

export type Guard = {
  model?: string
  effort?: string
  /** "from → to" when Claude Code switched models on its own. */
  fallback?: string
  /** The saved default this session no longer matches. */
  stale?: string
}

declare module 'claude-code' {
  interface PluginState {
    redhelm: {
      agents: Record<string, Agent>
      notes: Note[]
      inbox: Message[]
      workspaces: Workspace[]
      guard: Guard
      selected: string | null
      composing: string | null
      now: number
      placement: Placement
      /** Bottom placement only: folded down to the one-line alert. */
      collapsed: boolean
      /** Settings still to apply; empty once applied or set aside. */
      setup: SetupItem[]
      usage: Usage
    }
  }
}
