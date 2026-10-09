import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Guard, Note, Placement, SetupItem } from '../types'
import { DEFAULTS, LINES, activity, capital, fromConversation, type Said, handleOf, handles, base, changedFile, excerpt, kilo, kindOf, relative, remember, settings, short, span, staleTarget, type Settings } from './model'
import { laneNames, workspaces, type Io } from './sources'
import { Alert, Panel, Sheet, type Actions, type Els, type View } from './view'

type $ = EngineInterface

const PANE = 'redhelm'
/** The agent sheet: a second pane, opened as a dialog over one agent. */
const SHEET = 'redhelm-agent'
const TITLE = 'REDhelm'

const AGENTS = { plugin: 'redhelm', key: 'agents' } as const
const WORKSPACES = { plugin: 'redhelm', key: 'workspaces' } as const
const GUARD = { plugin: 'redhelm', key: 'guard' } as const
const PLACEMENT = { plugin: 'redhelm', key: 'placement' } as const
const SETUP = { plugin: 'redhelm', key: 'setup' } as const
const USAGE = { plugin: 'redhelm', key: 'usage' } as const

const agents = atom(AGENTS, {})
const showDone = atom({ plugin: 'redhelm', key: 'showDone' } as const, false)
const aside = atom({ plugin: 'redhelm', key: 'aside' } as const, false)
const notes = atom({ plugin: 'redhelm', key: 'notes' } as const, [])
const inbox = atom({ plugin: 'redhelm', key: 'inbox' } as const, [])
const spaces = atom(WORKSPACES, [])
const guard = atom(GUARD, {})
const INSPECTING = { plugin: 'redhelm', key: 'inspecting' } as const
const inspecting = atom(INSPECTING, null)
const briefOpen = atom({ plugin: 'redhelm', key: 'briefOpen' } as const, false)
const COMPOSING = { plugin: 'redhelm', key: 'composing' } as const
const composing = atom(COMPOSING, null)
const now = atom({ plugin: 'redhelm', key: 'now' } as const, 0)
const placement = atom(PLACEMENT, 'right' as Placement)
const collapsed = atom({ plugin: 'redhelm', key: 'collapsed' } as const, false)
const setup = atom(SETUP, [] as SetupItem[])
const usage = atom(USAGE, {})

const ENDED = new Set(['completed', 'failed', 'killed'])
const LIVE = new Set(['pending', 'running', 'waiting'])
/** How long an agent may be missing from Claude Code's list before REDhelm counts it as finished. */
const GRACE_MS = 20_000

/** Bookkeeping never gets in the way of the call it watches. */
const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {}
}

const blank = (id: string, at: number): Agent => ({
  id, name: '', type: 'agent', description: '', status: 'running',
  context: 0, startedAt: at, recent: [], files: [], edits: 0, fails: 0, steps: [],
})

/** Change one agent, creating it if its first event beat the spawn hook. */
async function patch($: $, id: string, fn: (a: Agent) => Partial<Agent>) {
  const at = await $.clock.now()
  await update($, agents, all => {
    const a = all[id] ?? blank(id, at)
    return { ...all, [id]: { ...a, ...fn(a) } }
  })
}

async function note($: $, n: Omit<Note, 'at'>) {
  const at = await $.clock.now()
  await update($, notes, list => [...list, { ...n, at }].slice(-40))
}

/** What an agent is called in REDhelm's messages and in the "→ name:" address. */
const labelOf = (a?: Agent) => a?.name || excerpt(a?.description, 24) || a?.type || 'agent'

const nameOf = async ($: $, id: string) => labelOf((await $.state.get(AGENTS)).value?.[id])

/** A prompt addressed to an agent: "→ handle: message". */
const ADDRESS = /^→ ([^:\n]+): ([\s\S]*)$/

/** The agent an address names, preferring one still running. */
async function agentNamed($: $, name: string) {
  const all = Object.values((await $.state.get(AGENTS)).value ?? {})
  const hs = handles(all)
  const wanted = name.trim().toLowerCase()
  const replying = (await $.state.get(COMPOSING)).value
  if (replying && hs[replying]?.toLowerCase() === wanted) return replying
  const named = all.filter(a => hs[a.id]!.toLowerCase() === wanted)
  return (named.find(a => LIVE.has(a.status)) ?? named[0])?.id
}

/** The sources' window on the host: the session root and $.fs. */
async function io($: $): Promise<Io> {
  return {
    root: await $.session.root(),
    read: path => $.fs.read(path),
    stat: path => $.fs.stat(path),
    list: dir => $.fs.list(dir),
    exists: path => $.fs.exists(path),
  }
}

/** Agents whose end REDhelm has already announced, so each is announced once. */
const told = new Set<string>()

/** "✓ docs finished": a note and, when wanted, a pop-up. */
async function announce($: $, id: string, failed: boolean, said = '') {
  if (told.has(id)) return
  told.add(id)
  const name = await nameOf($, id)
  await note($, { kind: failed ? 'fail' : 'done', text: `${name}  ${excerpt(said, 60)}`, agentId: id })
  if (cfg.agentToasts) $.ui.toast(`${failed ? '✕' : '✓'} ${name} ${failed ? 'failed' : 'finished'}`)
}

/** Agents whose conversation REDhelm has already read back, so each is read once. */
const readBack = new Set<string>()

/** Fills in an agent REDhelm did not watch from the start, from what Claude Code kept of its conversation. */
async function backfill($: $, id: string) {
  if (readBack.has(id)) return
  readBack.add(id)
  const said = await $.session.messages({ agentId: id })
  if (!Array.isArray(said)) return
  const got = fromConversation(said as Said[], root)
  // What REDhelm saw itself wins; the conversation only fills what is missing.
  await patch($, id, a => ({
    brief: a.brief ?? got.brief,
    thinking: a.thinking ?? got.thinking,
    ...(!a.steps?.length && { steps: got.steps, recent: got.recent }),
    ...(!a.files.length && { files: got.files, edits: got.edits }),
    fails: a.fails || got.fails,
  }))
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Merges the engine's agent list; writes only on change, and ticks the clock only while agents are live. */
async function sync($: $) {
  const at = await $.clock.now()
  const list = await $.agent.list()
  const merge = (all: Record<string, Agent>) => {
    const next = { ...all }
    for (const info of list) {
      const a = next[info.id] ?? blank(info.id, at)
      next[info.id] = {
        ...a,
        name: info.name ?? a.name,
        type: info.type,
        description: info.description || a.description,
        status: info.status,
        endedAt: ENDED.has(info.status) ? a.endedAt ?? at : undefined,
      }
    }
    // Claude Code drops an agent from its list once it is done; one REDhelm still shows as live,
    // gone from the list past a short grace, has finished (no ghosts "running" for hours).
    const listed = new Set(list.map(i => i.id))
    for (const a of Object.values(next)) {
      if (LIVE.has(a.status) && !listed.has(a.id) && at - a.startedAt > GRACE_MS) {
        next[a.id] = { ...a, status: 'completed', endedAt: a.endedAt ?? at, activity: undefined }
      }
    }
    const finished = Object.values(next).filter(a => ENDED.has(a.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    for (const a of finished.slice(20)) delete next[a.id]
    return next
  }
  const current = (await $.state.get(AGENTS)).value ?? {}
  const merged = merge(current)
  if (!same(current, merged)) await update($, agents, merge)
  for (const info of list) if (!current[info.id] && LIVE.has(info.status)) void quietly(() => backfill($, info.id))
  // An agent whose turn ended while work it started was still running ends later; say so then.
  // A ghost (dropped from the list unseen) is announced only if it had answered.
  const listed = new Set(list.map(i => i.id))
  for (const [id, a] of Object.entries(merged)) {
    const was = current[id]
    if (was && LIVE.has(was.status) && ENDED.has(a.status) && (listed.has(id) || was.answer)) await announce($, id, a.status === 'failed', was.answer)
  }
  if (Object.values(merged).some(a => LIVE.has(a.status))) await update($, now, () => at)
}

// The model guard: what the person chose, what actually answers, and whether the session fell behind

/** The person's REDhelm settings (/config); a change there reloads the module with the new values. */
let cfg: Settings = settings()
/** A draft meant for Claude, held while you message an agent and put back after. */
let setAside: string | undefined
/** The person's theme, so REDhelm's surfaces match it. */
let theme: 'light' | 'dark' = 'dark'
/** The session's project root (set at session start). */
let root = ''
/** Off in sessions nobody watches (claude -p, SDK, spawned runs): every hook passes straight through. */
let active = false
/** The pane opens by itself at most once a session, and never after the person used /redhelm. */
let autoOpened = false
/** The model the person chose for the main thread: the first to answer, then each /model. */
let chosen: string | undefined
/** The stale default the person was already told about; they are told once. */
let staleTold: string | undefined
/** null until the first call, so a reload always re-pins (or clears) the line. */
let shownStatus: string | undefined | null = null
/** Whether python3 runs here (the shipped status lines need it); undefined until asked. */
let hasPython: boolean | undefined
/** The command that worked for desktop notifications here; null when none does. */
let notifier: string[] | null | undefined

const statusText = (g: Guard) => {
  const model = [short(g.model), g.effort].filter(Boolean).join(' · ')
  if (g.fallback) return `✕ Model switched on its own: ${g.fallback} · /model to choose`
  if (g.stale) return `⚠ ${model} · your default is now ${short(g.stale)} · /model to switch`
  return model ? `● ${model}` : undefined
}

/** Pins the guard's line under the prompt; only redraws when the line changes. */
async function status($: $) {
  const g = (await $.state.get(GUARD)).value ?? {}
  const problem = !!(g.fallback || g.stale)
  const text = cfg.statusLine === 'off' || (cfg.statusLine === 'problems' && !problem) ? undefined : statusText(g)
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

/** Is this session behind the default new sessions get? A picker alias resolves to the newest version seen. */
async function checkStale($: $) {
  const g = (await $.state.get(GUARD)).value ?? {}
  const model = g.model ?? (await $.session.model())
  if (!model.startsWith('claude-')) return status($)
  const recorded = ((await $.store.get('newest')) ?? {}) as Record<string, string>
  const known = remember(recorded, model)
  if (known !== recorded) await $.store.set('newest', known)
  const wanted = (await $.settings.read()).model
  const stale = cfg.guard === 'off' ? undefined : staleTarget(model, typeof wanted === 'string' ? wanted : undefined, known)
  if (g.model !== model || g.stale !== stale) await update($, guard, x => ({ ...x, model: x.model ?? model, stale }))
  await status($)
}

/** Re-reads workspaces and the stale check; writes only on change, so idle polling never redraws. */
async function refresh($: $) {
  const t = (await $.settings.read()).theme
  theme = typeof t === 'string' && t.includes('light') ? 'light' : 'dark'
  const list = await workspaces(await io($))
  if (!same((await $.state.get(WORKSPACES)).value, list)) await $.state.set(WORKSPACES, list)
  await checkStale($)
}

/** A desktop notification where the platform has one (macOS, Linux), else nothing beyond the toast. */
async function notify($: $, title: string, subtitle: string, body: string) {
  if (notifier === null) return
  const q = (s: string) => `"${s.replace(/[\\"]/g, m => `\\${m}`)}"`
  const tries = notifier
    ? [notifier]
    : [['osascript', '-e'], ['notify-send']]
  for (const cmd of tries) {
    const argv = cmd[0] === 'osascript'
      ? [...cmd, `display notification ${q(body)} with title ${q(title)} subtitle ${q(subtitle)} sound name "Glass"`]
      : [...cmd, title, `${subtitle}\n${body}`]
    try {
      if ((await $.process.run(argv)).exitCode === 0) {
        notifier = cmd
        return
      }
    } catch {}
  }
  notifier = null
}

// The setup card: the Claude Code settings REDhelm brings, applied only when the person presses Apply

const LINE_KEYS = new Set<string>(LINES.map(l => l.key))

const home = async ($: $) => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''

/** The command for one of REDhelm's shipped status lines, from wherever REDhelm is installed. */
const lineCommand = ($: $, script: string) =>
  `python3 "${$.plugin.root.replace(/[\\/]\.claude-plugin$/, '')}/statusline/${script}"`

async function pythonRuns($: $) {
  if (hasPython === undefined) {
    try {
      hasPython = (await $.process.run(['python3', '--version'])).exitCode === 0
    } catch {
      hasPython = false
    }
  }
  return hasPython
}

/** Settings already applied or set aside; the card offers each one once, and /redhelm setup offers them all again. */
async function setupHandled($: $) {
  const keys = (await $.store.get('setupSeen')) as string[] | undefined
  if (keys) return keys
  return (await $.store.get('setup')) ? DEFAULTS.map(d => d.key) : [] // before v0.3: one flag for all
}

async function setupItems($: $, all = false): Promise<SetupItem[]> {
  const skip = all ? [] : await setupHandled($)
  const rows = await $.config.list()
  const items: SetupItem[] = DEFAULTS.flatMap(d => {
    const row = rows.find(r => r.key === d.key)
    const value = row && !row.isLocked ? d.want(row.options) : undefined
    return row && value !== undefined && row.value !== value && !skip.includes(d.key) ? [{ key: d.key, label: d.label, value }] : []
  })
  if (await pythonRuns($)) {
    const current = (await $.settings.read()) as Record<string, { command?: string } | undefined>
    for (const line of LINES) {
      const command = lineCommand($, line.script)
      if (current[line.key]?.command === command || skip.includes(line.key)) continue
      items.push({ key: line.key, label: current[line.key] ? `${line.label} (replaces your current one)` : line.label, value: command })
    }
  }
  return items
}

/** Writes REDhelm's status lines into the person's settings.json, keeping everything else in it. */
async function writeLines($: $, lines: SetupItem[]) {
  if (!lines.length) return
  const path = `${await home($)}/.claude/settings.json`
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : '{}'
  const json = JSON.parse(text || '{}') as Record<string, unknown>
  for (const l of lines) json[l.key] = { type: 'command', command: l.value }
  await $.fs.write(path, `${JSON.stringify(json, null, 2)}\n`)
}

async function applySetup($: $) {
  const items = (await $.state.get(SETUP)).value ?? []
  let applied = 0
  for (const item of items.filter(i => !LINE_KEYS.has(i.key))) {
    try {
      const r = await $.config.set({ key: item.key, value: item.value } as Parameters<$['config']['set']>[0])
      if (!r.deny) applied++
    } catch {}
  }
  const lines = items.filter(i => LINE_KEYS.has(i.key))
  try {
    await writeLines($, lines)
    applied += lines.length
  } catch {}
  await $.store.set('setupSeen', [...new Set([...(await setupHandled($)), ...items.map(i => i.key)])])
  await update($, setup, () => [])
  $.ui.toast(applied === items.length ? `REDhelm settings applied` : `Applied ${applied} of ${items.length} settings`)
}

async function skipSetup($: $) {
  const items = (await $.state.get(SETUP)).value ?? []
  await $.store.set('setupSeen', [...new Set([...(await setupHandled($)), ...items.map(i => i.key)])])
  await update($, setup, () => [])
}

/** /redhelm models: what actually answered this session, and the latest model switches. */
async function modelsReport($: $) {
  const use = (await $.state.get(USAGE)).value ?? {}
  const switches = ((await $.store.get('switches')) ?? []) as { at: number; from: string; to: string; source: string }[]
  const at = await $.clock.now()
  const rows = Object.entries(use).sort((a, b) => b[1].requests - a[1].requests)
  const lines = [
    'Models this session (what actually answered):',
    ...(rows.length
      ? rows.map(([m, u]) => `  ${short(m).padEnd(12)} ${String(u.requests).padStart(5)} requests   ${kilo(u.output).padStart(6)} output   ${u.agents} by agents`)
      : ['  none yet']),
    '',
    'Recent model switches:',
    ...(switches.length
      ? switches.slice(-5).reverse().map(s => `  ${span(at - s.at).padStart(4)} ago  ${short(s.from)} → ${short(s.to)}  (${s.source === 'auto' ? 'on its own' : s.source})`)
      : ['  none']),
  ]
  return lines.join('\n')
}

// Drawing

function actions($: $): Actions {
  const open = () => void $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => {})
  return {
    open,
    inspect: id =>
      void (async () => {
        await update($, briefOpen, () => false)
        await update($, inspecting, () => id)
        if (!id) return $.ui.close({ id: SHEET })
        await quietly(() => backfill($, id))
        await $.ui.open({ id: SHEET, title: await nameOf($, id), focus: true, closeOnEscape: true, rows: 24 })
      })().catch(() => {}),
    toggleBrief: () => void update($, briefOpen, x => !x),
    compose: id =>
      void (async () => {
        if (!id) return update($, composing, () => null)
        if ((await $.state.get(INSPECTING)).value === id) await $.ui.close({ id: SHEET }).catch(() => {})
        // What you were typing to Claude is set aside, never sent to the agent; it comes back after.
        const text = (await $.prompt.read()).text
        const already = text.match(ADDRESS)
        if (!already && text.trim()) setAside = text
        const handle = handles(Object.values((await $.state.get(AGENTS)).value ?? {}))[id] ?? 'agent'
        const { isFilled } = await $.prompt.fill({ text: `→ ${handle}: ${already ? already[2] : ''}`, mode: 'replace' })
        if (isFilled) {
          await update($, composing, () => id)
          await update($, aside, () => setAside !== undefined)
        }
        else $.ui.toast('Could not reach the prompt; type → name: your message')
      })(),
    dismiss: messageId => void update($, inbox, list => list.filter(m => m.id !== messageId)),
    stop: id =>
      void (async () => {
        const name = await nameOf($, id)
        await $.tool.call({ tool: 'TaskStop', task_id: id })
        await note($, { kind: 'fail', text: `${name} stopped by you`, agentId: id })
      })(),
    toggleDone: () => void update($, showDone, x => !x),
    applySetup: () => void quietly(() => applySetup($)),
    skipSetup: () => void quietly(() => skipSetup($)),
  }
}

/** The surface's elements; Input only where the surface takes typing (mobile does not). */
const elements = (table: unknown, surface: string): Els =>
  surface === 'mobile' ? { ...(table as Els), Input: undefined } : (table as Els)

async function view($: $): Promise<View> {
  const list = await read($, spaces)
  const all = Object.values(await read($, agents)).sort((a, b) => a.startedAt - b.startedAt)
  const hs = handles(all)
  // Agents sharing a name are told apart on screen exactly as in their address.
  const tagged = Object.fromEntries(all.filter(a => hs[a.id] !== handleOf(a)).map(a => [a.id, capital(hs[a.id]!)]))
  return {
    now: await read($, now),
    agents: all,
    handles: hs,
    notes: await read($, notes),
    inbox: await read($, inbox),
    workspaces: list,
    guard: await read($, guard),
    inspecting: await read($, inspecting),
    briefOpen: await read($, briefOpen),
    theme,
    composing: await read($, composing),
    setup: await read($, setup),
    showDone: await read($, showDone),
    aside: await read($, aside),
    root,
    lanes: { ...tagged, ...laneNames(list) },
  }
}

async function show($: $) {
  if (!cfg.autoOpen || autoOpened || (await $.state.get(PLACEMENT)).value === 'bottom') return
  autoOpened = true
  void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
}

export const register: Register = (on, options) => {
  cfg = settings(options as Record<string, unknown>)
  let timers: { cancel: () => void }[] = []

  on('session.start', async ($, e, next) => {
    active = e.isInteractive
    if (!active) return next(e)
    hasPython = undefined
    shownStatus = null
    root = await $.session.root()
    await update($, placement, () => cfg.placement)
    await $.command.register({
      name: 'redhelm',
      description: 'Your agents, their work and what needs you',
      argumentHint: 'right | bottom | setup | models',
    })
    timers.forEach(t => t.cancel())
    timers = [$.clock.every(1500, () => void quietly(() => sync($))), $.clock.every(5000, () => void quietly(() => refresh($)))]
    void quietly(async () => {
      const items = await setupItems($)
      await update($, setup, () => items)
      await refresh($)
      const ws = (await $.state.get(WORKSPACES)).value ?? []
      if (ws.length || ((await $.state.get(SETUP)).value ?? []).length) await show($)
    })
    return next(e)
  })

  on('session.end', ($, e, next) => {
    timers.forEach(t => t.cancel())
    timers = []
    return next(e)
  })

  on('command.run', { command: 'redhelm' }, async ($, e) => {
    autoOpened = true
    const arg = e.args.trim().toLowerCase()
    if (arg === 'models') return { text: await modelsReport($) }
    if (arg === 'setup') {
      const items = await setupItems($, true)
      await update($, setup, () => items)
      if (!items.length) return { text: 'Claude Code already has every REDhelm setting' }
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
      return { text: `REDhelm setup: ${items.length} ${items.length === 1 ? 'setting' : 'settings'} to review` }
    }
    if (arg === 'right' || arg === 'bottom') {
      // Saved as the person's REDhelm setting, the same row /config shows.
      await quietly(async () => {
        const row = (await $.config.list()).find(r => /^redhelm(@inline)?\.placement$/.test(r.key))
        if (row) await $.config.set({ key: row.key, value: arg } as Parameters<$['config']['set']>[0])
      })
      await update($, placement, () => arg)
      await update($, collapsed, () => false)
      if (arg === 'bottom') await $.ui.close({ id: PANE })
      else await $.ui.open({ id: PANE, title: TITLE, focus: true })
      return { text: `REDhelm now lives ${arg === 'right' ? 'on the right' : 'at the bottom'}` }
    }
    if ((await $.state.get(PLACEMENT)).value === 'bottom') {
      const folded = await update($, collapsed, c => !c)
      return { text: folded ? 'REDhelm folded' : 'REDhelm open' }
    }
    const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
    if (shown) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: shown ? 'REDhelm closed' : 'REDhelm open' }
  })

  /** The guard at the door: a prompt waits while the model is not the one chosen, and once when the session fell behind. */
  on('prompt.submit', async ($, e, next) => {
    if (!active) return next(e)
    // A prompt addressed "→ name: …" goes to that agent instead of Claude.
    const address = e.text.match(ADDRESS)
    const to = address && (await agentNamed($, address[1]!))
    if (address && to) {
      const name = address[1]!.trim()
      const text = address[2]!.trim()
      if (!text) return { drop: `REDhelm: nothing to send to ${name}` }
      const { isDelivered, reason } = await $.session.send({ to: { agentId: to }, text })
      await update($, composing, () => null)
      if (!isDelivered) return { drop: `REDhelm: not delivered to ${name} (${reason ?? 'unknown reason'})` }
      await update($, inbox, list => list.filter(m => m.agentId !== to))
      await note($, { kind: 'reply', text: `you → ${name}: ${excerpt(text, 60)}`, agentId: to })
      if (setAside !== undefined) {
        const draft = setAside
        setAside = undefined
        await update($, aside, () => false)
        // After Claude Code has cleared the prompt it just took.
        $.clock.after(100, () => void $.prompt.fill({ text: draft, mode: 'replace' }))
      }
      return { drop: `→ ${name}: sent` }
    }
    if (cfg.guard !== 'hold') return next(e)
    const g = (await $.state.get(GUARD)).value ?? {}
    if (g.fallback) {
      return { drop: `REDhelm: this session switched models on its own (${g.fallback}). Run /model to choose, then send again.` }
    }
    if (g.stale && staleTold !== g.stale) {
      staleTold = g.stale
      return { drop: `REDhelm: this session runs ${short(g.model)}, but your default is now ${short(g.stale)}. Send again to keep ${short(g.model)}, or /model to switch.` }
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId
    if (active && id) {
      await quietly(async () => {
        await patch($, id, () => ({
          model: r.model, type: e.subagentType, name: e.name ?? '', description: e.description, status: 'running',
          brief: e.prompt.slice(0, 2000),
        }))
        await note($, { kind: 'spawn', text: `${e.name || e.description}  ${short(r.model)}`, agentId: id })
        await show($)
      })
    }
    return r
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('turn.step', async function* ($, e, next) {
    if (!active) return yield* next(e)
    const result = yield* next(e)
    await quietly(async () => {
      const u = result.usage
      const context = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      const effort = e.effort === undefined ? undefined : String(e.effort)
      await update($, usage, all => {
        const m = base(e.model)
        const row = all[m] ?? { requests: 0, output: 0, agents: 0 }
        return { ...all, [m]: { requests: row.requests + 1, output: row.output + (u?.output_tokens ?? 0), agents: row.agents + (e.agentId ? 1 : 0) } }
      })
      if (e.agentId) {
        const said = excerpt(result.answer, 300)
        return patch($, e.agentId, a => ({ model: e.model, effort: effort ?? a.effort, context: context || a.context, thinking: said || a.thinking }))
      }
      chosen ??= e.model
      const switched = cfg.guard !== 'off' && base(e.model) !== base(chosen) ? `${short(chosen)} → ${short(e.model)}` : undefined
      const before = (await $.state.get(GUARD)).value ?? {}
      await update($, guard, g => ({ ...g, model: e.model, effort: effort ?? g.effort, fallback: switched ?? g.fallback }))
      if (switched && before.fallback !== switched) {
        await note($, { kind: 'guard', text: `answered by ${short(e.model)}, not ${short(chosen)}` })
        $.ui.toast(`✕ ${short(e.model)} answered instead of ${short(chosen)}`)
      }
      if (before.model !== e.model) await checkStale($)
      else await status($)
    })
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (!active) return next(e)
    const id = e.agentId
    if (!id) {
      const g = (await $.state.get(GUARD)).value ?? {}
      return g.fallback && cfg.guard === 'hold'
        ? { deny: `REDhelm: held because the session switched models on its own (${g.fallback}). Ask the person to run /model.` }
        : next(e)
    }
    const input = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    await quietly(() => {
      const file = changedFile(e.tool, input)
      const path = file && relative(file, root)
      return patch($, id, a => ({
        waitingOn: undefined,
        steps: [{ text: activity(e.tool, input), at: now }, ...(a.steps ?? [])].slice(0, 8),
        activity: activity(e.tool, input),
        recent: [...a.recent, kindOf(e.tool)].slice(-8),
        ...(path && { files: [...a.files.filter(f => f !== path), path].slice(-30), edits: a.edits + 1 }),
      }))
    })
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true && kindOf(e.tool) === 'checking') {
      await quietly(() => patch($, id, a => ({ fails: a.fails + 1 })))
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!active) return r
    const id = e.agentId
    await quietly(async () => {
      if (!id) {
        if (cfg.notifyAfter > 0 && e.durationMs >= cfg.notifyAfter * 1000) {
          const project = root.split(/[\\/]/).filter(Boolean).pop() ?? 'Claude Code'
          await notify($, `Claude Code · ${project}`, `Finished after ${span(e.durationMs)}`, excerpt(e.answer, 140) || 'Turn finished')
        }
        return
      }
      const failed = e.reason === 'error' || e.reason === 'refusal'
      // A turn can end while work the agent started still runs (Claude Code lists it as waiting): not finished yet.
      const held = (await $.agent.list()).find(i => i.id === id)
      if (held && LIVE.has(held.status) && !e.isAborted && !failed) return patch($, id, () => ({ answer: excerpt(e.answer, 160), activity: undefined }))
      const at = await $.clock.now()
      await patch($, id, () => ({
        answer: excerpt(e.answer, 160), endedAt: at,
        status: e.isAborted ? 'killed' : failed ? 'failed' : 'completed', activity: undefined,
      }))
      await announce($, id, failed, e.answer)
    })
    return r
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    const from = e.agentId
    if (active && from && r.isDelivered) await quietly(async () => {
      const peers = await $.agent.list()
      const peer = peers.find(p => p.id === e.to || p.name === e.to || p.teammateId === e.to)
      if (peer) await patch($, from, () => ({ waitingOn: peer.name || excerpt(peer.description, 24) || 'another agent' }))
      if (!peer) {
        const at = await $.clock.now()
        await update($, inbox, list => [...list, { id: `${from}-${at}`, agentId: from, text: e.text, at }].slice(-20))
        const name = await nameOf($, from)
        await note($, { kind: 'ask', text: `${name}: ${excerpt(e.text, 60)}`, agentId: from })
        if (cfg.agentToasts) $.ui.toast(`◆ ${name} sent you a message`)
      }
    })
    return r
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  /** Every model change: the person's choice resets the guard; Claude Code's own (auto) trips it. All are logged. */
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    if (!active) return r
    await quietly(async () => {
      const auto = e.source === 'auto'
      if (!auto) chosen = e.to_model
      const fallback = auto && cfg.guard !== 'off' ? `${short(e.from_model)} → ${short(e.to_model)}` : undefined
      await update($, guard, g => ({ ...g, model: e.to_model, fallback }))
      const at = await $.clock.now()
      const log = ((await $.store.get('switches')) ?? []) as unknown[]
      await $.store.set('switches', [...log, { at, from: e.from_model, to: e.to_model, source: e.source }].slice(-100))
      if (fallback) {
        await note($, { kind: 'guard', text: `Claude Code switched models: ${fallback}` })
        $.ui.toast(`✕ Model switched on its own: ${fallback}`)
      }
      await checkStale($)
    })
    return r
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    return <Panel
      els={elements($.ui.resolve(e), e.surface)}
      v={await view($)}
      act={actions($)}
      shape={{ kind: e.props.placement === 'dock' ? 'tall' : 'wide', columns: e.props.bodyColumns, rows: e.viewport?.rows ?? 12 }}
    />
  })

  on('ui.render', { component: 'Pane', requestId: SHEET }, async ($, e) => (
    <Sheet els={elements($.ui.resolve(e), e.surface)} v={await view($)} act={actions($)} columns={e.props.bodyColumns} />
  ))

  /** Above the prompt: the whole rack in bottom placement, otherwise only a pulled-out strip. */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!active || e.props.hasSurvey) return next(e)
    // One REDhelm on screen: while the pane is open, the band steps aside.
    const paneShown = await $.ui.panes().then(ps => ps.some(p => p.id === PANE && p.isShown), () => false)
    if (paneShown) return next(e)
    const els = elements($.ui.resolve(e), e.surface)
    const v = await view($)
    const act = actions($)
    if ((await read($, placement)) === 'bottom' && !(await read($, collapsed))) {
      return <Panel els={els} v={v} act={act} shape={{ kind: 'wide', columns: e.props.bodyColumns, rows: Math.min(e.props.maxRows, 6), rule: true }} />
    }
    return Alert({ els, v, act }) ?? next(e)
  })
}
