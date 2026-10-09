import type { Elements } from 'claude-code'

import type { Agent, Guard, Lane, Message, Note, Run, SetupItem, Workspace } from '../types'
import { areas, excerpt, isStale, kilo, overlaps, phase, short, span } from './model'

/**
 * REDhelm's one idea, borrowed from air traffic control's flight progress strips:
 * every agent is a strip in a rack, ordered by who needs you next, and a strip that
 * needs you is pulled out of line (a controller "cocks" a strip to flag it). Only a
 * strip's edge carries its state; the rest of the panel stays quiet.
 */

/** The elements every surface has, plus Input where the surface takes typing (typed, so a prop no surface takes fails tsc). */
type Table = Elements['terminal']
export type Els = Pick<Table, 'Box' | 'Text' | 'Button'> & { Input?: Table['Input'] }

export type Actions = {
  select: (id: string | null) => void
  compose: (id: string | null) => void
  stop: (id: string) => void
  dismiss: (messageId: string) => void
  open: () => void
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
  lanes: Record<string, string>
}

// Tokens

const C = { live: 'green', attention: 'yellow', fault: 'red', brand: 'red', model: 'cyan' } as const

const LIVE = new Set<Agent['status']>(['pending', 'running', 'waiting'])

const EDGE = (a: Agent, cocked: boolean) =>
  cocked ? { glyph: '▌', color: C.attention }
  : a.status === 'failed' ? { glyph: '▌', color: C.fault }
  : LIVE.has(a.status) ? { glyph: '▌', color: C.live }
  : { glyph: '▏', color: undefined }

const NOTE: Record<Note['kind'], string> = { spawn: '+', done: '✓', fail: '✕', ask: '◆', reply: '↩', guard: '!' }

// The rack

type Strip = { agent: Agent; messages: Message[]; cocked: boolean }

export const label = (a: Agent, lanes: Record<string, string>) =>
  lanes[a.id] || a.name || excerpt(a.description, 28) || a.type

/** Who needs you next: pulled-out strips, then live by start, then the most recently finished. */
export function rack(v: View): Strip[] {
  const strips = v.agents.map(agent => {
    const messages = v.inbox.filter(m => m.agentId === agent.id)
    return { agent, messages, cocked: agent.status === 'waiting' || messages.length > 0 }
  })
  const rank = (s: Strip) => (s.cocked ? 0 : LIVE.has(s.agent.status) ? 1 : 2)
  return strips.sort((a, b) =>
    rank(a) - rank(b) ||
    (rank(a) === 2 ? (b.agent.endedAt ?? 0) - (a.agent.endedAt ?? 0) : a.agent.startedAt - b.agent.startedAt))
}

const modelChip = (a: Agent, v: View) => {
  const text = [short(a.model), a.effort].filter(Boolean).join(' · ')
  return { text, stale: isStale(a.model, v.guard.stale ?? v.guard.model) }
}

const facts = (a: Agent, v: View) =>
  [span((a.endedAt ?? v.now) - a.startedAt), a.context ? kilo(a.context) : '', a.fails ? `${a.fails} failed` : '']
    .filter(Boolean)
    .join(' · ')

const doing = (a: Agent) =>
  LIVE.has(a.status) ? [phase(a.recent), a.activity].filter(Boolean).join(' · ') || 'starting' : a.answer || a.status

/** The expanded strip: its task, its last word, what it touched, and what you can do. */
function Drawer({ els, s, v, act, indent }: { els: Els; s: Strip; v: View; act: Actions; indent: number }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const live = LIVE.has(a.status)
  return (
    <Box flexDirection="column" paddingLeft={indent} marginBottom={1}>
      {a.description && <Text wrap="wrap">{a.description}</Text>}
      {a.answer && <Text dimColor wrap="wrap">→ {a.answer}</Text>}
      {a.files.length > 0 && (
        <Text dimColor wrap="truncate-end">
          {a.files.slice(-3).map(f => f.split('/').pop()).join(', ')}
          {a.files.length > 3 ? `  +${a.files.length - 3}` : ''}
        </Text>
      )}
      {v.composing === a.id && (
        <Text color={C.attention}>↓ type in the prompt below · Enter sends to {label(a, v.lanes)}</Text>
      )}
      {(live || s.messages.length > 0) && (
        <Box gap={2} marginTop={1}>
          <Button key={`compose-${a.id}`} label={s.messages.length ? 'Reply' : 'Message'} variant="primary" onPress={() => act.compose(a.id)} />
          {live && <Button key={`stop-${a.id}`} label="Stop" onPress={() => act.stop(a.id)} />}
        </Box>
      )}
    </Box>
  )
}

/** Dock shape: a two-line strip. Line one names it, line two says what it is doing (or asking). */
function TallStrip({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const edge = EDGE(a, s.cocked)
  const chip = modelChip(a, v)
  const live = LIVE.has(a.status)
  const open = v.selected === a.id
  const ask = s.messages.at(-1)
  return (
    <Box flexDirection="column" marginLeft={s.cocked ? 0 : 1}>
      <Box justifyContent="space-between">
        <Box gap={1} flexShrink={1}>
          <Text color={edge.color} dimColor={!edge.color}>{edge.glyph}</Text>
          <Button key={`sel-${a.id}`} plain dimColor={!live && !s.cocked} label={label(a, v.lanes)} onPress={() => act.select(open ? null : a.id)} />
        </Box>
        <Text color={chip.stale ? C.attention : C.model} dimColor={!live && !chip.stale}>{chip.stale ? `⚠ ${chip.text}` : chip.text}</Text>
      </Box>
      <Box justifyContent="space-between" paddingLeft={2}>
        {ask ? (
          <Text color={C.attention} wrap="truncate-end">◆ {excerpt(ask.text, 200)}</Text>
        ) : a.status === 'waiting' ? (
          <Text color={C.attention}>waiting on you</Text>
        ) : (
          <Text dimColor wrap="truncate-end">{doing(a)}</Text>
        )}
        <Text dimColor>{facts(a, v)}</Text>
      </Box>
      {open && <Drawer els={els} s={s} v={v} act={act} indent={2} />}
    </Box>
  )
}

/** Strip shape: one line per agent, for the wide, short bottom panel. */
function WideStrip({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const edge = EDGE(a, s.cocked)
  const chip = modelChip(a, v)
  const live = LIVE.has(a.status)
  const open = v.selected === a.id
  const ask = s.messages.at(-1)
  return (
    <Box flexDirection="column" marginLeft={s.cocked ? 0 : 1}>
      <Box justifyContent="space-between" gap={2}>
        <Box gap={1} flexShrink={1}>
          <Text color={edge.color} dimColor={!edge.color}>{edge.glyph}</Text>
          <Button key={`sel-${a.id}`} plain dimColor={!live && !s.cocked} label={label(a, v.lanes)} onPress={() => act.select(open ? null : a.id)} />
          {ask ? (
            <Text color={C.attention} wrap="truncate-end">◆ {excerpt(ask.text, 200)}</Text>
          ) : (
            <Text dimColor wrap="truncate-end">{a.status === 'waiting' ? 'waiting on you' : doing(a)}</Text>
          )}
        </Box>
        <Box gap={2} flexShrink={0}>
          <Text color={chip.stale ? C.attention : C.model} dimColor={!live && !chip.stale}>{chip.stale ? `⚠ ${chip.text}` : chip.text}</Text>
          <Text dimColor>{facts(a, v)}</Text>
        </Box>
      </Box>
      {open && <Drawer els={els} s={s} v={v} act={act} indent={3} />}
    </Box>
  )
}

function Rack({ els, v, act, limit }: { els: Els; v: View; act: Actions; limit: number }) {
  const { Box, Text } = els
  const strips = rack(v)
  const live = strips.filter(s => s.cocked || LIVE.has(s.agent.status))
  const shown = strips.slice(0, Math.max(live.length, limit))
  const hidden = strips.length - shown.length
  if (!strips.length) return <Text dimColor>No agents yet</Text>
  return (
    <Box flexDirection="column" gap={1}>
      {shown.map(s => <TallStrip key={s.agent.id} els={els} s={s} v={v} act={act} />)}
      {hidden > 0 && <Text dimColor>  {hidden} earlier</Text>}
    </Box>
  )
}

// The setup card: REDhelm's own strip, with the Claude Code settings it brings

function SetupCard({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  if (!v.setup.length) return null
  return (
    <Box flexDirection="column">
      <Text><Text color={C.brand}>▌</Text> <Text bold>Set up REDhelm</Text> <Text dimColor>· {v.setup.length} Claude Code {v.setup.length === 1 ? 'setting' : 'settings'}</Text></Text>
      {v.setup.map(item => <Text key={`s-${item.key}`} dimColor wrap="truncate-end">  + {item.label}</Text>)}
      <Box gap={2} marginTop={1} paddingLeft={2}>
        <Button key="setup-apply" label="Apply" variant="primary" onPress={act.applySetup} />
        <Button key="setup-skip" label="Not now" onPress={act.skipSetup} />
      </Box>
    </Box>
  )
}

// The header

/** A workspace's name, short: "Demo app (web folder) — beta" → "Demo app". */
export const shortName = (name: string) => name.split(/\s[(—–-]\s?/)[0]!.trim() || name

/** Only a problem with the model earns a place here; the status line shows the model otherwise. */
function Problem({ els, g }: { els: Els; g: Guard }) {
  const { Text } = els
  if (g.fallback) return <Text color={C.fault} wrap="truncate-end">✕ switched {g.fallback} · /model</Text>
  if (g.stale) return <Text color={C.attention} wrap="truncate-end">⚠ default is now {short(g.stale)} · /model</Text>
  return null
}

const counts = (v: View) => {
  const live = v.agents.filter(a => LIVE.has(a.status)).length
  const done = v.agents.length - live
  return live || done ? [live && `${live} live`, done && `${done} done`].filter(Boolean).join(' · ') : 'no agents'
}

function Header({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  return (
    <Box justifyContent="space-between" gap={2}>
      <Text>
        <Text bold color={C.brand}>RED</Text><Text bold>helm</Text>
        <Text dimColor>  {counts(v)}</Text>
      </Text>
      <Problem els={els} g={v.guard} />
    </Box>
  )
}

// The bays: where work lands, and the workflows around it

/** The one line between the rack and the bays. */
function Rule({ els, width }: { els: Els; width: number }) {
  const { Text } = els
  return <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
}

function WorkLanding({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  const clash = overlaps(v.agents)
  const map = areas(v.agents).slice(0, 3)
  if (!clash.length && !map.length) return null
  const names = (ids: Iterable<string>) =>
    [...ids].map(id => v.agents.find(a => a.id === id)).filter(Boolean).map(a => label(a!, v.lanes)).join(', ')
  return (
    <Box flexDirection="column">
      {clash.map(c => (
        <Text key={`c-${c.file}`} color={C.attention} wrap="truncate-end">⚠ {c.file.split('/').pop()} · both {names(c.ids)}</Text>
      ))}
      {map.map(m => (
        <Box key={`a-${m.area}`} justifyContent="space-between" gap={2}>
          <Text wrap="truncate-end">{m.area}/  <Text dimColor>{names(m.agents)}</Text></Text>
          <Text dimColor>{m.files.size} {m.files.size === 1 ? 'file' : 'files'}</Text>
        </Box>
      ))}
    </Box>
  )
}

const bar = (done: number, total: number, width: number) => {
  const n = total ? Math.round((done / total) * width) : 0
  return ['━'.repeat(n), '─'.repeat(width - n)] as const
}

function Progress({ els, done, total, width = 10 }: { els: Els; done: number; total: number; width?: number }) {
  const { Text } = els
  const [full, empty] = bar(done, total, width)
  return <Text><Text color={C.live}>{full}</Text><Text dimColor>{empty}</Text> <Text dimColor>{done}/{total}</Text></Text>
}

const STAGE: Record<string, { glyph: string; color?: string }> = {
  yes: { glyph: '✓', color: C.live },
  doing: { glyph: '◐', color: C.attention },
  wait: { glyph: '◷', color: C.attention },
  skip: { glyph: '–' },
  no: { glyph: '·' },
}

function Stages({ els, stages, values }: { els: Els; stages: string[]; values: Record<string, string> }) {
  const { Text } = els
  return (
    <Text>
      {stages.map(s => {
        const mark = STAGE[values[s] ?? ''] ?? STAGE.no!
        return <Text color={mark.color} dimColor={!mark.color}>{mark.glyph}</Text>
      })}
    </Text>
  )
}

const RUN: Record<string, string> = { ACTIVE: C.live, PAUSED: C.attention, BLOCKED: C.fault }

function RunLine({ els, run }: { els: Els; run: Run }) {
  const { Box, Text } = els
  const status = (run.status.split(/\s/)[0] ?? '').toUpperCase()
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" gap={2}>
        <Text wrap="truncate-end"><Text color={RUN[status]} dimColor={!RUN[status]}>●</Text> {run.name}</Text>
        <Text dimColor>{[status.toLowerCase(), run.open ? `${run.open} open` : ''].filter(Boolean).join(' · ')}</Text>
      </Box>
      {run.next && <Text dimColor wrap="truncate-end">  next: {run.next}</Text>}
    </Box>
  )
}

function Bay({ els, ws, rich }: { els: Els; ws: Workspace; rich: boolean }) {
  const { Box, Text } = els
  const lanes = (ws.lanes ?? []).filter(l => l.total)
  const done = lanes.reduce((n, l) => n + l.done, 0)
  const total = lanes.reduce((n, l) => n + l.total, 0)
  const meta = [
    ws.studio && `${ws.studio.standards} standards`,
    ws.board && `${ws.board.rows.length} open`,
  ].filter(Boolean).join(' · ')
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" gap={2}>
        <Text bold wrap="truncate-end">{shortName(ws.name)}</Text>
        {total ? <Progress els={els} done={done} total={total} /> : <Text dimColor>{meta}</Text>}
      </Box>
      {rich && lanes.filter(l => l.done < l.total).slice(0, 3).map((l: Lane) => (
        <Text key={`l-${l.id}`} dimColor wrap="truncate-end">  {l.title} · {l.active ?? `${l.done}/${l.total}`}</Text>
      ))}
      {rich && ws.board?.rows.slice(0, 3).map(r => (
        <Box key={`b-${r.id}`} justifyContent="space-between" gap={2}>
          <Text dimColor wrap="truncate-end">  {r.id}</Text>
          <Stages els={els} stages={ws.board!.stages} values={r.stages} />
        </Box>
      ))}
      {ws.runs?.slice(0, rich ? 2 : 1).map(r => <RunLine key={`r-${r.name}`} els={els} run={r} />)}
    </Box>
  )
}

function Log({ els, v, count }: { els: Els; v: View; count: number }) {
  const { Box, Text } = els
  if (!v.notes.length) return null
  return (
    <Box flexDirection="column">
      {v.notes.slice(-count).reverse().map(n => (
        <Box key={`n-${n.at}-${n.text}`} gap={1}>
          <Text dimColor>{span(v.now - n.at).padStart(4)}</Text>
          <Text dimColor wrap="truncate-end">{NOTE[n.kind]} {n.text}</Text>
        </Box>
      ))}
    </Box>
  )
}

function Bays({ els, v, rich }: { els: Els; v: View; rich: boolean }) {
  const { Box } = els
  return (
    <Box flexDirection="column" gap={1}>
      <WorkLanding els={els} v={v} />
      {v.workspaces.map(ws => <Bay key={`ws-${ws.dir}`} els={els} ws={ws} rich={rich} />)}
      <Log els={els} v={v} count={rich ? 4 : 2} />
    </Box>
  )
}

// Shapes

/** Right dock: tall and narrow. Header, the rack, one rule, the bays. */
function Tall({ els, v, act, columns }: { els: Els; v: View; act: Actions; columns: number }) {
  const { Box } = els
  return (
    <Box flexDirection="column" gap={1} width={columns}>
      <Header els={els} v={v} />
      <SetupCard els={els} v={v} act={act} />
      <Rack els={els} v={v} act={act} limit={6} />
      <Rule els={els} width={columns} />
      <Bays els={els} v={v} rich />
    </Box>
  )
}

/** One workspace as a few words for the bottom bar: "Game 28/36", "Demo app 24 open", "run-name active". */
export const summary = (ws: Workspace) => {
  const lanes = (ws.lanes ?? []).filter(l => l.total)
  const total = lanes.reduce((n, l) => n + l.total, 0)
  const run = ws.runs?.[0]
  return [
    total ? `${shortName(ws.name)} ${lanes.reduce((n, l) => n + l.done, 0)}/${total}`
      : ws.board ? `${shortName(ws.name)} ${ws.board.rows.length} open`
      : ws.studio ? `${shortName(ws.name)} ${ws.studio.standards} standards` : '',
    run && run.status ? `${run.name} ${run.status.split(/\s/)[0]!.toLowerCase()}` : '',
  ].filter(Boolean).join(' · ')
}

/** Bottom: wide and short. One bar, then one line per agent that is live or needs you; nothing wraps. */
function Wide({ els, v, act, columns, rows }: { els: Els; v: View; act: Actions; columns: number; rows: number }) {
  const { Box, Text } = els
  const strips = rack(v).filter(s => s.cocked || LIVE.has(s.agent.status))
  const room = Math.max(0, rows - 2 - (v.setup.length ? v.setup.length + 2 : 0)) // the rule and the bar
  const shown = strips.slice(0, room)
  const bays = v.workspaces.map(summary).filter(Boolean).join('   ')
  return (
    <Box flexDirection="column" width={columns}>
      <Rule els={els} width={columns} />
      <Box justifyContent="space-between" gap={3}>
        <Box flexShrink={0}>
          <Text>
            <Text bold color={C.brand}>RED</Text><Text bold>helm</Text>
            <Text dimColor>  {counts(v)}</Text>
          </Text>
        </Box>
        {v.guard.fallback || v.guard.stale
          ? <Problem els={els} g={v.guard} />
          : <Text dimColor wrap="truncate-end">{bays}</Text>}
      </Box>
      <SetupCard els={els} v={v} act={act} />
      {shown.map(s => <WideStrip key={s.agent.id} els={els} s={s} v={v} act={act} />)}
      {strips.length > shown.length && <Text dimColor>  +{strips.length - shown.length} more · /redhelm right for all</Text>}
    </Box>
  )
}

export type Shape = { kind: 'tall' | 'wide'; columns: number; rows: number }

export function Panel({ els, v, act, shape }: { els: Els; v: View; act: Actions; shape: Shape }) {
  return shape.kind === 'tall'
    ? <Tall els={els} v={v} act={act} columns={shape.columns} />
    : <Wide els={els} v={v} act={act} columns={shape.columns} rows={shape.rows} />
}

/** With the panel closed: one line above the prompt, only when a strip is pulled out. */
export function Alert({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const pulled = rack(v).filter(s => s.cocked)
  const first = pulled[0]
  const body = v.guard.fallback
    ? <Text color={C.fault} wrap="truncate-end">✕ Claude Code switched models on its own · {v.guard.fallback}</Text>
    : first
      ? (
        <Text wrap="truncate-end">
          <Text color={C.attention}>▌</Text> <Text bold>{label(first.agent, v.lanes)}</Text>{' '}
          <Text color={C.attention}>{first.messages.length ? `◆ ${excerpt(first.messages.at(-1)!.text, 90)}` : 'waiting on you'}</Text>
          {pulled.length > 1 && <Text dimColor>  +{pulled.length - 1}</Text>}
        </Text>
      )
      : v.setup.length
        ? <Text wrap="truncate-end"><Text color={C.brand}>▌</Text> <Text bold>Set up REDhelm</Text> <Text dimColor>· {v.setup.length} settings to review</Text></Text>
        : null
  if (!body) return null
  return (
    <Box justifyContent="space-between" gap={2}>
      {body}
      <Button key="open-redhelm" plain label="open REDhelm" onPress={act.open} />
    </Box>
  )
}
