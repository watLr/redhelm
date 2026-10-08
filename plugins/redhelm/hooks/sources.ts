import type { Run, Workspace } from '../types'
import { foldLanes, foldStatusBoard, parseRun, parseStandards } from './model'

/** What the sources need from the host; register.tsx builds it from io. */
export type Io = {
  root: string
  read: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ mtimeMs: number }>
  list: (dir: string) => Promise<readonly { name: string; kind: string }[]>
  exists: (path: string) => Promise<boolean>
}

const join = (...p: string[]) => p.join('/').replace(/\/+/g, '/')
const leaf = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir

/** Reads a file only when it changed since the last read; null when missing. */
const cache = new Map<string, { at: number; text: string }>()
const read = async (io: Io, path: string) => {
  try {
    const { mtimeMs } = await io.stat(path)
    const hit = cache.get(path)
    if (hit?.at === mtimeMs) return hit.text
    const text = await io.read(path)
    cache.set(path, { at: mtimeMs, text })
    return text
  } catch {
    return null
  }
}

const json = async (io: Io, path: string) => {
  const text = await read(io, path)
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const dirs = async (io: Io, dir: string) => {
  try {
    return (await io.list(dir)).filter(e => e.kind === 'dir' && !e.name.startsWith('.')).map(e => join(dir, e.name))
  } catch {
    return []
  }
}

const MARKERS = ['.redstudio', '.status-board', '.redmanager', 'docs/aaa/board/lanes.json']

const isWorkspace = async (io: Io, dir: string) => {
  for (const m of MARKERS) if (await io.exists(join(dir, m))) return true
  return false
}

async function runs(io: Io, dir: string): Promise<Run[]> {
  const root = join(dir, '.redmanager')
  const found: { run: Run; at: number }[] = []
  for (const at of [root, ...(await dirs(io, root))]) {
    for (const file of ['current.json', 'state.md']) {
      const text = await read(io, join(at, file))
      if (text === null) continue
      const { mtimeMs } = await io.stat(join(at, file))
      found.push({ run: parseRun(at === root ? leaf(dir) : leaf(at), text), at: mtimeMs })
      break
    }
  }
  return found.sort((a, b) => b.at - a.at).map(f => f.run)
}

async function workspace(io: Io, dir: string): Promise<Workspace> {
  const ws: Workspace = { dir, name: leaf(dir) }

  const standards = await read(io, join(dir, '.redstudio/standards.md'))
  if (standards !== null) ws.studio = parseStandards(standards)

  const events = await read(io, join(dir, '.status-board/events.jsonl'))
  if (events !== null) {
    const config = await json(io, join(dir, '.status-board/config.json'))
    const stages: string[] = config?.stages ?? ['Done', 'Verified', 'Reviewed', 'Shipped']
    ws.board = { stages, ...foldStatusBoard(events, stages) }
    if (config?.name) ws.name = config.name
  }

  const lanes = await json(io, join(dir, 'docs/aaa/board/lanes.json'))
  if (lanes) {
    const byLane: Record<string, string> = {}
    for (const lane of lanes.lanes ?? []) {
      byLane[lane.id] = (await read(io, join(dir, `docs/aaa/board/events/${lane.id}.jsonl`))) ?? ''
    }
    ws.lanes = foldLanes(lanes, byLane)
  }

  if (await io.exists(join(dir, '.redmanager'))) ws.runs = await runs(io, dir)

  return ws
}

/** The session root, the folders above it and the ones right below it that hold a workflow. */
export async function workspaces(io: Io): Promise<Workspace[]> {
  const root = io.root
  const up: string[] = []
  for (let dir = root; up.length < 4; ) {
    up.push(dir)
    const parent = dir.replace(/[\\/][^\\/]+$/, '')
    if (!parent || parent === dir) break
    dir = parent
  }
  const found: Workspace[] = []
  for (const dir of [...up, ...(await dirs(io, root))]) {
    if (await isWorkspace(io, dir)) found.push(await workspace(io, dir))
  }
  return found
}

/** Lane boards name the agents they own: agentId → lane title. */
export const laneNames = (list: Workspace[]) =>
  Object.fromEntries(list.flatMap(ws => ws.lanes ?? []).flatMap(l => (l.agent ? [[l.agent, l.title]] : [])))
