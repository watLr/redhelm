import type { Agent, Lane, Phase, Placement, Run, StageRow } from '../types'

// The person's REDhelm settings (/config rows from the manifest's userConfig), defaults filled in

export type Settings = {
  placement: Placement
  statusLine: 'problems' | 'always' | 'off'
  guard: 'hold' | 'warn' | 'off'
  notifyAfter: number
  autoOpen: boolean
  agentToasts: boolean
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T) =>
  allowed.includes(value as T) ? (value as T) : fallback

export const settings = (o: Record<string, unknown> = {}): Settings => ({
  placement: pick(o.placement, ['right', 'bottom'] as const, 'right'),
  statusLine: pick(o.statusLine, ['problems', 'always', 'off'] as const, 'off'),
  guard: pick(o.guard, ['hold', 'warn', 'off'] as const, 'hold'),
  notifyAfter: typeof o.notifyAfter === 'number' && o.notifyAfter >= 0 ? o.notifyAfter : 120,
  autoOpen: o.autoOpen !== false,
  agentToasts: o.agentToasts !== false,
})

// Models: the same rules as ~/.claude/model-guard/mg_common.py

export const base = (model = '') => (model.split('[')[0] ?? '').replace(/-\d{8}$/, '')

const parts = (model?: string) => base(model).split('-')

export const family = (model?: string) => parts(model)[1] ?? ''

const version = (model?: string) => parts(model).slice(2).filter(p => /^\d+$/.test(p)).map(Number)

export const newer = (a: string, b: string) => {
  const [x, y] = [version(a), version(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** Another version of the same family: Opus 5 while the default is Opus 5.5. */
export const isStale = (actual?: string, wanted?: string) =>
  !!actual && !!wanted && family(actual) === family(wanted) && base(actual) !== base(wanted)

/** claude-opus-5-5[1m] → Opus 5.5 */
export const short = (model?: string) => {
  if (!model?.startsWith('claude-')) return model ?? ''
  const [, name = '', ...rest] = parts(model)
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${rest.filter(p => /^\d+$/.test(p)).join('.')}`.trim()
}

/** The newest version of each family seen so far, so a picker alias ("opus") resolves to a version. */
export const remember = (seen: Record<string, string>, model?: string) => {
  if (!model?.startsWith('claude-')) return seen
  const fam = family(model)
  const cur = seen[fam]
  return cur && !newer(model, cur) ? seen : { ...seen, [fam]: base(model) }
}

/** The default this session has fallen behind, if any: the saved model (alias resolved), or a newer one seen since. */
export const staleTarget = (model: string, wanted: string | undefined, seen: Record<string, string>) => {
  if (!wanted) return undefined
  const resolved = wanted.startsWith('claude-') ? wanted : seen[wanted]
  if (!resolved) return undefined
  const newest = seen[family(resolved)]
  const target = newest && newer(newest, resolved) ? newest : resolved
  return isStale(model, target) ? base(target) : undefined
}

// The Claude Code settings REDhelm brings, as /config rows (applied only when the person presses Apply)

export type Default = { key: string; label: string; want: (options?: readonly string[]) => string | boolean | undefined }

export const DEFAULTS: Default[] = [
  { key: 'switchModelsOnFlag', label: 'Pause instead of switching models when safeguards flag a message', want: o => o?.find(x => !/switch/i.test(x)) },
  { key: 'turnDuration', label: 'Show how long each turn took', want: () => true },
  { key: 'timestamps', label: 'Timestamp every message', want: () => true },
  { key: 'inputNeededNotifEnabled', label: 'Push to your phone when a question is waiting', want: () => true },
]

/** The status lines REDhelm ships (statusline/ in its folder), written into settings.json: no /config row exists for them. */
export const LINES = [
  { key: 'statusLine', script: 'statusline.py', label: 'Show the model that actually answers, with its effort, under the prompt' },
  { key: 'subagentStatusLine', script: 'agents.py', label: "Show each agent's model and effort in Claude Code's agent panel" },
] as const

// Numbers and time

export const kilo = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

// Text

const MARKUP = /[#*`_>|]+/g

/** The first line worth reading, without markdown. */
export const excerpt = (text = '', size = 120) => {
  const line = text.split('\n').map(l => l.replace(MARKUP, '').trim()).find(Boolean) ?? ''
  return line.length > size ? `${line.slice(0, size - 1)}…` : line
}

const leaf = (path = '') => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** One tool call as a few words: "Edit server.ts", "Bash npm test". */
export const activity = (tool: string, input: Record<string, unknown>) => {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const target =
    leaf(str('file_path') || str('notebook_path') || str('path')) ||
    str('command').trim().split(/\s+/).slice(0, 2).join(' ') ||
    str('pattern') ||
    str('description') ||
    str('url')
  const name = tool.startsWith('mcp__') ? tool.split('__').pop()! : tool
  return excerpt(`${name} ${target}`, 48)
}

// What agents do, read from their tool calls (works with no workflow at all)

const KINDS: Record<string, Phase> = {
  Edit: 'building', Write: 'building', NotebookEdit: 'building', MultiEdit: 'building',
  Bash: 'checking', PowerShell: 'checking',
  Agent: 'delegating', Task: 'delegating', SendMessage: 'delegating',
}

export const kindOf = (tool: string): Phase => KINDS[tool] ?? 'exploring'

/** The phase its last few calls point at; the newest call wins a tie. */
export const phase = (recent: Phase[]): Phase | undefined => {
  const last = recent.slice(-5)
  let best: Phase | undefined
  let most = 0
  for (const p of [...last].reverse()) {
    const n = last.filter(q => q === p).length
    if (n > most) [best, most] = [p, n]
  }
  return best
}

export const changedFile = (tool: string, input: Record<string, unknown>) =>
  KINDS[tool] === 'building' && typeof (input.file_path ?? input.notebook_path) === 'string'
    ? ((input.file_path ?? input.notebook_path) as string)
    : undefined

export const relative = (path: string, root: string) =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

/** Changed files grouped by top-level folder: where the work is landing, and who is on it. */
export const areas = (agents: Agent[]) => {
  const map = new Map<string, { area: string; files: Set<string>; agents: Set<string> }>()
  for (const a of agents) {
    for (const f of a.files) {
      const area = f.includes('/') ? f.slice(0, f.indexOf('/')) : '.'
      const row = map.get(area) ?? { area, files: new Set(), agents: new Set() }
      row.files.add(f)
      row.agents.add(a.id)
      map.set(area, row)
    }
  }
  return [...map.values()].sort((a, b) => b.files.size - a.files.size)
}

/** Files two or more live agents are changing at once. */
export const overlaps = (agents: Agent[]) => {
  const live = agents.filter(a => a.status === 'running' || a.status === 'waiting')
  const owners = new Map<string, string[]>()
  for (const a of live) for (const f of new Set(a.files)) owners.set(f, [...(owners.get(f) ?? []), a.id])
  return [...owners].filter(([, ids]) => ids.length > 1).map(([file, ids]) => ({ file, ids }))
}

// Workspace formats

const lines = (text: string) =>
  text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line)
      return row && typeof row === 'object' ? [row] : []
    } catch {
      return []
    }
  })

const SETTLED = new Set(['yes', 'skip'])

/** status-board: fold events.jsonl into rows; keep the ones not yet through every stage. */
export const foldStatusBoard = (text: string, stages: string[]) => {
  const rows = new Map<string, StageRow>()
  for (const e of lines(text)) {
    if (typeof e.id !== 'string') continue
    const row = rows.get(e.id) ?? { id: e.id, stages: {}, note: '', at: 0 }
    Object.assign(row.stages, e.stages ?? {})
    if (e.note) row.note = e.note
    row.at = Date.parse(e.t) || row.at
    rows.set(e.id, row)
  }
  const all = [...rows.values()]
  const isOpen = (r: StageRow) => stages.some(s => !SETTLED.has(r.stages[s] ?? ''))
  return { rows: all.filter(isOpen).sort((a, b) => b.at - a.at), total: all.length }
}

const PIPELINE = ['cause', 'fix', 'looked', 'checked', 'gated', 'closed']
const CHECKED = PIPELINE.indexOf('checked')

/** Lane board: lanes.json plus each lane's events, as progress per lane. */
export const foldLanes = (spec: any, events: Record<string, string>) =>
  (Array.isArray(spec?.lanes) ? spec.lanes : []).map((lane: any): Lane => {
    const items: any[] = lane.items ?? []
    const last = new Map<string, { stage: string; status?: string }>()
    for (const e of lines(events[lane.id] ?? '')) if (e.item) last.set(String(e.item), e)
    const rank = (id: unknown) => PIPELINE.indexOf(last.get(String(id))?.stage ?? '')
    // Finished once independently checked and marked done; nothing on these boards reaches "closed".
    const isDone = (id: unknown) => rank(id) >= CHECKED && (last.get(String(id))?.status === 'done' || rank(id) === PIPELINE.length - 1)
    const done = items.filter(i => isDone(i.id)).length
    const active = items.filter(i => rank(i.id) >= 0 && !isDone(i.id)).sort((a, b) => rank(b.id) - rank(a.id))[0]
    return { id: lane.id, title: lane.title ?? lane.id, done, total: items.length, active: active?.title, agent: lane.agent }
  })

/** REDManager: a v2 current.json or a v1 state.md ledger. */
export const parseRun = (name: string, text: string): Run => {
  if (text.trimStart().startsWith('{')) {
    try {
      const run = JSON.parse(text)
      return {
        name: run.run_id ?? name,
        status: run.status ?? '',
        next: run.next_action,
        open: run.open_attempts?.length ?? 0,
      }
    } catch {}
  }
  const field = (re: RegExp) => text.match(re)?.[1]?.replace(/[`*]/g, '').trim()
  return {
    name,
    status: field(/^\s*-?\s*(?:Run status|Status)\s*:\s*(.+)$/im) ?? '',
    next: field(/^\s*-?\s*Next(?: action)?\s*:\s*(.+)$/im),
    open: (text.match(/^\|.*`(?:DISPATCHED|ACTIVE)`/gm) ?? []).length,
  }
}

/** REDStudio standards.md: how many, and the newest one's title. */
export const parseStandards = (text: string) => {
  const titles = [...text.matchAll(/^- \*\*S\d+ · [^·]+· ([^*]+?)\.?\*\*/gm)].map(m => (m[1] ?? '').trim())
  return { standards: titles.length, latest: titles.at(-1) }
}
