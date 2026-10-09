import type { Elements } from 'claude-code'

import type { Agent, Guard, Message, Note, Run, SetupItem, Workspace } from '../types'
import { capital, doing, excerpt, handleOf, isStale, kilo, minutes, modelWords, overlaps, short } from './model'

/**
 * REDhelm speaks in plain sentences. Agents that need you get a card with their question and
 * labeled buttons; the rest are one line each ("API is writing code · 9 min"); everything
 * else waits behind a click. No codes, no glyph legends, nothing to decode.
 */

/** The elements every surface has (typed, so a prop no surface takes fails tsc). */
type Table = Elements['terminal']
export type Els = Pick<Table, 'Box' | 'Text' | 'Button'> & { Input?: Table['Input'] }

export type Actions = {
  select: (id: string | null) => void
  compose: (id: string | null) => void
  stop: (id: string) => void
  dismiss: (messageId: string) => void
  open: () => void
  toggleDone: () => void
  applySetup: () => void
  skipSetup: () => void
}

export type View = {
  now: number
  agents: Agent[]
  notes: Note[]
  inbox: Message[]
  workspaces: Workspace[]
  guard: Guard
  selected: string | null
  composing: string | null
  setup: SetupItem[]
  showDone: boolean
  /** Each agent's message address (unique). */
  handles: Record<string, string>
  /** Whether a draft for Claude was set aside while you message an agent. */
  aside: boolean
  /** The session's project root, to tell this session's workflows from merely nearby ones. */
  root: string
  lanes: Record<string, string>
}

const C = { live: 'green', attention: 'yellow', fault: 'red', brand: 'red' } as const

const LIVE = new Set<Agent['status']>(['pending', 'running', 'waiting'])

type Strip = { agent: Agent; messages: Message[]; cocked: boolean }

/** An agent's name in REDhelm; one with no name or task gets a unique one ("Agent a169"), which is also its address. */
export const label = (a: Agent, lanes: Record<string, string>) =>
  capital(lanes[a.id] || a.name || excerpt(a.description, 28) || `agent ${a.id.slice(0, 4)}`)

/** Who needs you next: agents asking for you, then live ones by start, then the most recently finished. */
export function rack(v: View): Strip[] {
  const strips = v.agents.map(agent => {
    const messages = v.inbox.filter(m => m.agentId === agent.id)
    return { agent, messages, cocked: messages.length > 0 }
  })
  const rank = (s: Strip) => (s.cocked ? 0 : LIVE.has(s.agent.status) ? 1 : 2)
  return strips.sort((a, b) =>
    rank(a) - rank(b) ||
    (rank(a) === 2 ? (b.agent.endedAt ?? 0) - (a.agent.endedAt ?? 0) : a.agent.startedAt - b.agent.startedAt))
}

/** "1 needs you · 2 working", "3 finished", "No agents running" */
const counts = (v: View) => {
  const strips = rack(v)
  const needs = strips.filter(s => s.cocked).length
  const working = strips.filter(s => !s.cocked && LIVE.has(s.agent.status)).length
  const done = strips.length - needs - working
  const parts = [needs && `${needs} needs you`, working && `${working} working`, !needs && !working && done && `${done} finished`]
  return parts.filter(Boolean).join(' · ') || 'No agents running'
}

/** A workspace's name, short: "Demo app (web folder) — beta" → "Demo app". */
export const shortName = (name: string) => name.split(/\s[(—–-]\s?/)[0]!.trim() || name

// Pieces

function Brand({ els }: { els: Els }) {
  const { Text } = els
  return <Text><Text bold color={C.brand}>RED</Text><Text bold>helm</Text></Text>
}

function Header({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  return (
    <Box justifyContent="space-between" gap={2}>
      <Brand els={els} />
      <Text dimColor>{counts(v)}</Text>
    </Box>
  )
}

/** Only a problem with the model earns a line; the status line shows the model otherwise. */
function ModelNotice({ els, g }: { els: Els; g: Guard }) {
  const { Text } = els
  if (g.fallback) return <Text color={C.fault} wrap="wrap">The model changed without you ({g.fallback}). Run /model to choose.</Text>
  if (g.stale) return <Text color={C.attention} wrap="wrap">This session runs {short(g.model)}; your default is now {short(g.stale)}. Run /model to switch.</Text>
  return null
}

/** After Reply or Message: say where to type, so nobody presses the button again. */
function TypeHint({ els, handle, aside }: { els: Els; handle: string; aside: boolean }) {
  const { Text } = els
  return (
    <Text color={C.attention} wrap="truncate-end">↓ type below · Enter sends to {handle}{aside ? ' · your draft is saved' : ''}</Text>
  )
}

/** "just now", "4 min ago" */
const ago = (ms: number) => (ms < 60_000 ? 'just now' : `${minutes(ms)} ago`)

function AgentActions({ els, s, v, act, primary }: { els: Els; s: Strip; v: View; act: Actions; primary: string }) {
  const { Box, Button } = els
  const a = s.agent
  if (v.composing === a.id) return <TypeHint els={els} handle={v.handles[a.id] ?? handleOf(a)} aside={v.aside} />
  return (
    <Box gap={3}>
      <Button key={`compose-${a.id}`} label={primary} variant="primary" onPress={() => act.compose(a.id)} />
      {LIVE.has(a.status) && <Button key={`stop-${a.id}`} label="Stop" onPress={() => act.stop(a.id)} />}
    </Box>
  )
}

/** An agent that needs you: what it is working on, what it asks, and what you can do about it. */
function NeedsCard({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text } = els
  const a = s.agent
  const ask = s.messages.at(-1)
  const name = label(a, v.lanes)
  const task = a.description && a.description.toLowerCase() !== name.toLowerCase() ? a.description : undefined
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box justifyContent="space-between" gap={2}>
        <Text bold color={C.attention}>{name} needs your answer</Text>
        {ask && <Text dimColor>{ago(v.now - ask.at)}</Text>}
      </Box>
      {task && <Text dimColor wrap="wrap">Working on: {task}</Text>}
      {a.activity && <Text dimColor wrap="truncate-end">Was just: {a.activity}</Text>}
      {ask && <Text wrap="wrap">“{ask.text.trim().slice(0, 800)}”</Text>}
      <AgentActions els={els} s={s} v={v} act={act} primary={ask ? 'Reply' : 'Message'} />
    </Box>
  )
}

/** Everything about one agent, in words, shown when you open it. */
function Details({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text } = els
  const a = s.agent
  const live = LIVE.has(a.status)
  return (
    <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
      {a.description && <Text wrap="wrap">Task: {a.description}</Text>}
      {live && a.activity && <Text dimColor wrap="truncate-end">Right now: {a.activity}</Text>}
      {a.files.length > 0 && (
        <Text dimColor wrap="truncate-end">
          Changed: {a.files.slice(-3).map(f => f.split('/').pop()).join(', ')}{a.files.length > 3 ? ` and ${a.files.length - 3} more` : ''}
        </Text>
      )}
      {a.model && <Text dimColor>Model: {modelWords(a.model, a.effort)}{a.context ? ` · ${kilo(a.context)} tokens of context` : ''}</Text>}
      {a.fails > 0 && <Text color={C.attention}>{a.fails} {a.fails === 1 ? 'command' : 'commands'} failed</Text>}
      {a.answer && <Text dimColor wrap="wrap">Last said: “{a.answer}”</Text>}
      {live && <AgentActions els={els} s={s} v={v} act={act} primary="Message" />}
    </Box>
  )
}

/** A working agent: one plain sentence; press its name for the rest. */
function AgentLine({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const open = v.selected === a.id
  const older = isStale(a.model, v.guard.stale ?? v.guard.model)
  const toggle = () => act.select(open ? null : a.id)
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" gap={2}>
        <Box gap={1} flexShrink={1}>
          <Text color={C.live}>●</Text>
          <Button key={`sel-${a.id}`} plain label={label(a, v.lanes)} hover={{ underline: true, scope: `row-${a.id}` }} onPress={toggle} />
          <Text wrap="truncate-end">{doing(a)}</Text>
          {older && <Text color={C.attention}>· older model</Text>}
        </Box>
        <Box gap={2} flexShrink={0}>
          <Text dimColor>{minutes(v.now - a.startedAt)}</Text>
          <Button key={`more-${a.id}`} plain dimColor label={open ? '▾' : '▸'} hover={{ bold: true, scope: `row-${a.id}` }} onPress={toggle} />
        </Box>
      </Box>
      {open && <Details els={els} s={s} v={v} act={act} />}
    </Box>
  )
}

/** Finished agents fold into one line until you ask for them. */
function Finished({ els, v, act, strips }: { els: Els; v: View; act: Actions; strips: Strip[] }) {
  const { Box, Text, Button } = els
  if (!strips.length) return null
  const last = strips[0]!.agent
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" gap={2}>
        <Text dimColor wrap="truncate-end">✓ {strips.length} finished · last: {label(last, v.lanes)}</Text>
        <Button key="toggle-done" plain dimColor label={v.showDone ? 'Hide' : 'Show'} onPress={act.toggleDone} />
      </Box>
      {v.showDone && strips.slice(0, 8).map(s => (
        <Text key={`d-${s.agent.id}`} dimColor wrap="truncate-end">
          {'  '}{label(s.agent, v.lanes)} {doing(s.agent)}{s.agent.answer ? `: “${excerpt(s.agent.answer, 90)}”` : ''}
        </Text>
      ))}
    </Box>
  )
}

/** Two agents editing one file is the one thing about files worth interrupting you for. */
function Overlaps({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  const clash = overlaps(v.agents)
  if (!clash.length) return null
  const names = (ids: string[]) =>
    ids.map(id => v.agents.find(a => a.id === id)).filter(Boolean).map(a => label(a!, v.lanes)).join(' and ')
  return (
    <Box flexDirection="column">
      {clash.map(c => (
        <Text key={`c-${c.file}`} color={C.attention} wrap="wrap">{names(c.ids)} are both editing {c.file.split('/').pop()}</Text>
      ))}
    </Box>
  )
}

function SetupCard({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  if (!v.setup.length) return null
  return (
    <Box flexDirection="column">
      <Text bold>Finish setting up REDhelm</Text>
      {v.setup.map(item => <Text key={`s-${item.key}`} dimColor wrap="wrap">  • {item.label}</Text>)}
      <Box gap={3} marginTop={1} paddingLeft={2}>
        <Button key="setup-apply" label="Apply" variant="primary" onPress={act.applySetup} />
        <Button key="setup-skip" label="Not now" onPress={act.skipSetup} />
      </Box>
    </Box>
  )
}

// Workspaces: one plain line each

const bar = (done: number, total: number, width: number) => {
  const n = total ? Math.round((done / total) * width) : 0
  return ['━'.repeat(n), '─'.repeat(width - n)] as const
}

const FINISHED_RUN = /^(complete|completed|cancelled|canceled|cleared)\b/i

/**
 * The workflows worth a line: this session's project (the folder or one above it) or one an
 * agent here is changing files in; finished runs and boards with nothing open stay quiet.
 */
export function relevant(v: View): Workspace[] {
  const inside = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`)
  return v.workspaces
    .filter(ws => inside(ws.dir, v.root) || v.agents.some(a => a.files.some(f => inside(ws.dir, f.startsWith('/') ? f : `${v.root}/${f}`))))
    .map(ws => ({ ...ws, runs: ws.runs?.filter(r => r.status && !FINISHED_RUN.test(r.status)) }))
    .filter(ws => (ws.lanes ?? []).some(l => l.total > l.done) || (ws.board?.rows.length ?? 0) > 0 || (ws.runs?.length ?? 0) > 0)
}

/** "Game 28 of 36 done", "Demo app 4 tasks open", "demo-run active" */
export const summary = (ws: Workspace) => {
  const lanes = (ws.lanes ?? []).filter(l => l.total)
  const total = lanes.reduce((n, l) => n + l.total, 0)
  const open = ws.board?.rows.length ?? 0
  const run = ws.runs?.[0]
  return [
    total ? `${shortName(ws.name)} ${lanes.reduce((n, l) => n + l.done, 0)} of ${total} done`
      : ws.board ? `${shortName(ws.name)} ${open} ${open === 1 ? 'task' : 'tasks'} open`
      : ws.studio ? `${shortName(ws.name)} ${ws.studio.standards} standards` : '',
    run && run.status ? `${run.name} ${run.status.split(/\s/)[0]!.toLowerCase()}` : '',
  ].filter(Boolean).join(' · ')
}

function RunLine({ els, run }: { els: Els; run: Run }) {
  const { Text } = els
  const status = (run.status.split(/\s/)[0] ?? '').toLowerCase()
  return (
    <Text dimColor wrap="truncate-end">
      {'  '}Run {run.name}{status ? ` is ${status}` : ''}{run.next ? ` · next: ${run.next}` : ''}
    </Text>
  )
}

function WorkspaceLine({ els, ws }: { els: Els; ws: Workspace }) {
  const { Box, Text } = els
  const lanes = (ws.lanes ?? []).filter(l => l.total)
  const done = lanes.reduce((n, l) => n + l.done, 0)
  const total = lanes.reduce((n, l) => n + l.total, 0)
  const open = ws.board?.rows.length ?? 0
  const [full, empty] = bar(done, total, 12)
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" gap={2}>
        <Text bold wrap="truncate-end">{shortName(ws.name)}</Text>
        {total
          ? <Text><Text color={C.live}>{full}</Text><Text dimColor>{empty}</Text>  <Text dimColor>{done} of {total} done</Text></Text>
          : ws.board
            ? <Text dimColor>{open} {open === 1 ? 'task' : 'tasks'} open</Text>
            : ws.studio ? <Text dimColor>{ws.studio.standards} standards</Text> : null}
      </Box>
      {ws.runs?.slice(0, 1).map(r => <RunLine key={`r-${r.name}`} els={els} run={r} />)}
    </Box>
  )
}

function Rule({ els, width }: { els: Els; width: number }) {
  const { Text } = els
  return <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
}

// Shapes

/** Right dock: tall and narrow. */
function Tall({ els, v, act, columns }: { els: Els; v: View; act: Actions; columns: number }) {
  const { Box, Text } = els
  const strips = rack(v)
  const needs = strips.filter(s => s.cocked)
  const working = strips.filter(s => !s.cocked && LIVE.has(s.agent.status))
  const done = strips.filter(s => !s.cocked && !LIVE.has(s.agent.status))
  return (
    <Box flexDirection="column" gap={1} width={columns}>
      <Header els={els} v={v} />
      <ModelNotice els={els} g={v.guard} />
      <SetupCard els={els} v={v} act={act} />
      {needs.map(s => <NeedsCard key={`n-${s.agent.id}`} els={els} s={s} v={v} act={act} />)}
      {working.length > 0 && (
        <Box flexDirection="column">
          {working.map(s => <AgentLine key={s.agent.id} els={els} s={s} v={v} act={act} />)}
        </Box>
      )}
      {!strips.length && <Text dimColor>Agents you start show up here.</Text>}
      <Finished els={els} v={v} act={act} strips={done} />
      <Overlaps els={els} v={v} />
      {relevant(v).length > 0 && <Rule els={els} width={columns} />}
      {relevant(v).map(ws => <WorkspaceLine key={`ws-${ws.dir}`} els={els} ws={ws} />)}
    </Box>
  )
}

/** One line for an agent that needs you, for the short bottom bar. */
function NeedsLine({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text } = els
  const ask = s.messages.at(-1)
  return (
    <Box justifyContent="space-between" gap={2}>
      <Text wrap="truncate-end">
        <Text bold color={C.attention}>{label(s.agent, v.lanes)} needs your answer</Text>
        {ask ? <Text>: “{excerpt(ask.text, 160)}”</Text> : null}
      </Text>
      <AgentActions els={els} s={s} v={v} act={act} primary={ask ? 'Reply' : 'Message'} />
    </Box>
  )
}

/** Bottom: wide and short. The same sentences, one line each; nothing wraps. */
function Wide({ els, v, act, columns, rows }: { els: Els; v: View; act: Actions; columns: number; rows: number }) {
  const { Box, Text } = els
  const strips = rack(v)
  const needs = strips.filter(s => s.cocked)
  const working = strips.filter(s => !s.cocked && LIVE.has(s.agent.status))
  const room = Math.max(0, rows - 2 - (v.setup.length ? v.setup.length + 2 : 0)) // the rule and the header
  const shownNeeds = needs.slice(0, room)
  const shownWorking = working.slice(0, Math.max(0, room - shownNeeds.length))
  const hidden = needs.length + working.length - shownNeeds.length - shownWorking.length
  const right = v.guard.fallback || v.guard.stale ? null : relevant(v).map(summary).filter(Boolean).join('   ')
  return (
    <Box flexDirection="column" width={columns}>
      <Rule els={els} width={columns} />
      <Box justifyContent="space-between" gap={3}>
        <Box flexShrink={0} gap={2}>
          <Brand els={els} />
          <Text dimColor>{counts(v)}</Text>
        </Box>
        {right ? <Text dimColor wrap="truncate-end">{right}</Text> : <ModelNotice els={els} g={v.guard} />}
      </Box>
      <SetupCard els={els} v={v} act={act} />
      {shownNeeds.map(s => <NeedsLine key={`n-${s.agent.id}`} els={els} s={s} v={v} act={act} />)}
      {shownWorking.map(s => <AgentLine key={s.agent.id} els={els} s={s} v={v} act={act} />)}
      {hidden > 0 && <Text dimColor>and {hidden} more · /redhelm right shows them all</Text>}
    </Box>
  )
}

export type Shape = { kind: 'tall' | 'wide'; columns: number; rows: number }

export function Panel({ els, v, act, shape }: { els: Els; v: View; act: Actions; shape: Shape }) {
  return shape.kind === 'tall'
    ? <Tall els={els} v={v} act={act} columns={shape.columns} />
    : <Wide els={els} v={v} act={act} columns={shape.columns} rows={shape.rows} />
}

/** With the panel closed: one line above the prompt, only when something needs you. */
export function Alert({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const first = rack(v).find(s => s.cocked)
  const ask = first?.messages.at(-1)
  const body = v.guard.fallback
    ? <Text color={C.fault} wrap="truncate-end">The model changed without you ({v.guard.fallback}). Run /model to choose.</Text>
    : first
      ? (
        <Text wrap="truncate-end">
          <Text bold color={C.attention}>{label(first.agent, v.lanes)} needs your answer</Text>
          {ask ? <Text>: “{excerpt(ask.text, 90)}”</Text> : null}
        </Text>
      )
      : v.setup.length
        ? <Text wrap="truncate-end"><Text bold>Finish setting up REDhelm</Text><Text dimColor> · {v.setup.length} settings to review</Text></Text>
        : null
  if (!body) return null
  return (
    <Box justifyContent="space-between" gap={2}>
      {body}
      <Button key="open-redhelm" plain label="Open REDhelm" onPress={act.open} />
    </Box>
  )
}
