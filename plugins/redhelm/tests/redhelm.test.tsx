import { describe, expect, mock, test } from 'claude-code/testing'

import type { Agent } from '../types'

/** The test runtime has timers; the hooks environment's declarations leave them out. */
declare const setTimeout: (fn: () => void, ms: number) => unknown
import {
  DEFAULTS, activity, doing, handleOf, settings, foldLanes, foldStatusBoard, isStale, kindOf, overlaps, parseRun, parseStandards, phase, remember, short, staleTarget,
} from '../hooks/model'
import { workspaces, type Io } from '../hooks/sources'
import { label, rack, relevant, shortName, summary, type View } from '../hooks/view'

const agent = (over: Partial<Agent>): Agent => ({
  id: 'a1', name: 'docs', type: 'general-purpose', description: 'Rewrite the setup guide', status: 'running',
  context: 0, startedAt: 0, recent: [], files: [], edits: 0, fails: 0, steps: [], ...over,
})

/** An in-memory folder tree standing in for $.fs. */
const fakeIo = (files: Record<string, string>, root = '/p'): Io => {
  const isDir = (d: string) => Object.keys(files).some(f => f.startsWith(`${d}/`))
  return {
    root,
    read: async p => {
      if (!(p in files)) throw new Error(`missing ${p}`)
      return files[p]!
    },
    stat: async p => {
      if (!(p in files) && !isDir(p)) throw new Error(`missing ${p}`)
      return { mtimeMs: 1 }
    },
    exists: async p => p in files || isDir(p),
    list: async d => [...new Set(Object.keys(files).filter(f => f.startsWith(`${d}/`)).map(f => f.slice(d.length + 1).split('/')[0]!))]
      .map(name => ({ name, kind: isDir(`${d}/${name}`) ? 'dir' : 'file' })),
  }
}

describe('models', () => {
  test('names and staleness follow the guard scripts', async () => {
    expect(short('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(short('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(isStale('claude-opus-5[1m]', 'claude-opus-5-5')).toBe(true)
    expect(isStale('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(false)
    expect(isStale('claude-haiku-4-5', 'claude-opus-5-5')).toBe(false)
  })

  test('the saved default resolves a picker alias to the newest version seen', async () => {
    const seen = remember(remember({}, 'claude-opus-5-5[1m]'), 'claude-opus-6')
    expect(seen).toEqual({ opus: 'claude-opus-6' })
    expect(remember(seen, 'claude-opus-5')).toBe(seen)
    expect(staleTarget('claude-opus-5-5[1m]', 'opus', seen)).toBe('claude-opus-6')
    expect(staleTarget('claude-opus-6', 'opus', seen)).toBeUndefined()
    expect(staleTarget('claude-opus-5', 'claude-opus-5-5[1m]', {})).toBe('claude-opus-5-5')
  })

  test('setup asks for pause-on-flag, never for switching models automatically', async () => {
    const flag = DEFAULTS.find(d => d.key === 'switchModelsOnFlag')!
    expect(flag.want(['Switch automatically', 'Ask each time'])).toBe('Ask each time')
  })
})

describe('what agents do', () => {
  test('tool calls read as phase, activity and changed files', async () => {
    expect(activity('Edit', { file_path: '/p/src/app/server.ts' })).toBe('Edit server.ts')
    expect(activity('Bash', { command: 'npm test -- --watch' })).toBe('Bash npm test')
    expect(phase(['exploring', 'building', 'building', 'checking'])).toBe('building')
    expect(phase(['building', 'checking'])).toBe('checking')
    expect(kindOf('Grep')).toBe('exploring')
  })

  test('overlaps flag a file two live agents are both changing', async () => {
    const list = [
      agent({ id: 'a', files: ['src/guide/setup.md', 'src/app/index.ts'] }),
      agent({ id: 'b', name: 'camera', files: ['src/guide/setup.md', 'tools/cam.mjs'] }),
      agent({ id: 'c', status: 'completed', files: ['src/guide/setup.md'] }),
    ]
    expect(overlaps(list)).toEqual([{ file: 'src/guide/setup.md', ids: ['a', 'b'] }])
  })
})

describe('workflows', () => {
  test('status-board folds to open rows, newest first', async () => {
    const events = [
      '{"t":"2026-10-05T20:00:00Z","id":"P1","stages":{"Done":"yes","Verified":"yes","Reviewed":"yes","Shipped":"yes"}}',
      '{"t":"2026-10-05T20:10:00Z","id":"P2","note":"started","stages":{"Done":"doing"}}',
      '{"t":"2026-10-05T20:20:00Z","id":"P3","note":"first","stages":{"Done":"yes"}}',
      '{"t":"2026-10-05T20:30:00Z","id":"P4","stages":{"Done":"skip","Verified":"skip","Reviewed":"skip","Shipped":"skip"}}',
      'not json',
    ].join('\n')
    const { rows, total } = foldStatusBoard(events, ['Done', 'Verified', 'Reviewed', 'Shipped'])
    expect(total).toBe(4)
    expect(rows.map(r => r.id)).toEqual(['P3', 'P2'])
  })

  test('lane boards count checked-done items and show the furthest open one', async () => {
    const spec = { lanes: [{ id: 'api', title: 'API', agent: 'a1', items: [{ id: '1', title: 'Auth' }, { id: '2', title: 'Cache' }] }] }
    const lanes = foldLanes(spec, { api: '{"item":"1","stage":"checked","status":"done"}\n{"item":"2","stage":"looked","status":"done"}' })
    expect(lanes[0]).toEqual({ id: 'api', title: 'API', done: 1, total: 2, active: 'Cache', agent: 'a1' })
  })

  test('REDManager v1 ledgers and v2 snapshots both parse', async () => {
    expect(parseRun('demo-run', '# REDManager state ledger\n- Run status: `ACTIVE`\n| P1 | `DISPATCHED` |')).toEqual({
      name: 'demo-run', status: 'ACTIVE', next: undefined, open: 1,
    })
    expect(parseRun('x', '{"run_id":"r","status":"PAUSED","next_action":"Verify","open_attempts":[{}]}')).toEqual({
      name: 'r', status: 'PAUSED', next: 'Verify', open: 1,
    })
  })

  test('REDStudio standards count and newest title', async () => {
    const md = '- **S1 · 2026-10-01 · Short labels.** text\n- **S2 · 2026-10-02 · Real content first.** text'
    expect(parseStandards(md)).toEqual({ standards: 2, latest: 'Real content first' })
  })

  test('workspaces are found at the root and one level below', async () => {
    const io = fakeIo({
      '/p/app/.redstudio/standards.md': '- **S1 · 2026-10-01 · Short labels.** x',
      '/p/app/.status-board/events.jsonl': '{"t":"2026-10-05T20:10:00Z","id":"P2","stages":{"Done":"doing"}}',
      '/p/app/.status-board/config.json': '{"name":"Demo app","stages":["Done","Shipped"]}',
      '/p/game/docs/aaa/board/lanes.json': '{"lanes":[{"id":"api","title":"API","items":[{"id":"1"}]}]}',
      '/p/Plain/readme.md': 'no workflow',
      '/p/.redmanager/state.md': '- Run status: `ACTIVE`',
    })
    const found = await workspaces(io)
    expect(found.map(w => w.name)).toEqual(['p', 'Demo app', 'game'])
    expect(found[0]!.runs?.[0]?.status).toBe('ACTIVE')
    expect(found[1]!.studio?.standards).toBe(1)
    expect(found[1]!.board?.rows.length).toBe(1)
    expect(found[2]!.lanes?.[0]?.total).toBe(1)
  })
})

const PANE = {
  plugin: 'redhelm', component: 'Pane', requestId: 'redhelm',
  props: { title: 'REDhelm', isFocused: true, bodyColumns: 48, placement: 'dock' },
} as const

const SHEET = {
  plugin: 'redhelm', component: 'Pane', requestId: 'redhelm-agent',
  props: { title: 'Agent', isFocused: true, bodyColumns: 70, placement: 'inline' },
} as const

/** Click an agent's name on the panel, then look at the sheet it opens. */
const openSheet = async ($: any, ui: any, id: string, surface = 'terminal') => {
  await ui.press({ key: `sel-${id}` })
  return $.ui.mount({ ...SHEET, surface } as any)
}

/** Beneath REDhelm: the engine's session, spawn and tools answer without running anything. */
/** The mocked clock of the latest engine(), so a test can move time on. */
let clock: any
const engine = (on: any, isInteractive: boolean) => async ($: any) => {
  clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('classic.PostModelSwitch', () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => { // Claude Code's own (empty) band
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.start', () => ({ cwd: '/p' }))
  on('session.root', () => ({ value: '/p' }))
  on('command.register', () => ({ value: { command: 'redhelm' } }))
  let spawned = 0 // each spawn gets the next id: a1, a2, ...
  on('agent.spawn', () => ({ model: 'claude-opus-5-5[1m]', agentId: `a${++spawned}` }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive })
}

describe('the pane', () => {
  test('a spawned agent shows live on every surface, with Message on each', async ($, on) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    await $.tool.call({ tool: 'Edit', file_path: 'src/guide/setup.md', old_string: 'a', new_string: 'b', agentId: 'a1' } as any)

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any)
      expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
      expect(await ui.find({ type: 'Text', text: /is writing code/ })).toBeDefined()
      const sheet = await openSheet($, ui, 'a1', surface)
      expect(await sheet.find({ type: 'Text', text: /Asked to/ })).toBeDefined()
      expect(await sheet.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
      expect(await sheet.find({ type: 'Text', text: /Edit setup\.md/ })).toBeDefined()
      expect(await sheet.find({ key: 'compose-a1' })).toBeDefined() // messaging goes through the prompt, so every surface has it
      await sheet.unmount()
      await ui.unmount()
    }
  })

  test('stays out of sessions nobody watches (claude -p, SDK, spawned runs)', async ($, on) => {
    await engine(on, false)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ key: 'sel-a1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Agents you start show up here/ })).toBeDefined()
    await ui.unmount()
  })

  test('the bottom panel lays the rack out one line per agent, bays beside it', async ($, on) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 140 } } as any)
    expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
    expect(await ui.find({ type: 'Text', text: /is getting started/ })).toBeDefined()
    await ui.unmount()
  })

  test('/redhelm bottom moves the whole rack above the prompt, and /redhelm folds it', async ($, on) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const run = (args: string) => $.command.run({ command: 'redhelm', args, origin: { kind: 'person' }, presentation: {} } as any)
    const band = { plugin: 'redhelm', component: 'AbovePrompt', surface: 'terminal',
      props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120 } } as any

    expect((await run('bottom')).text).toBe('REDhelm now lives at the bottom')
    let ui = await $.ui.mount(band)
    expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
    await ui.unmount()

    expect((await run('')).text).toBe('REDhelm folded')
    ui = await $.ui.mount(band)
    expect(await ui.find({ key: 'sel-a1' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the rack', () => {
  test('orders strips by who needs you next and pulls out the ones that do', async () => {
    const v = {
      now: 0, notes: [], workspaces: [], guard: {}, inspecting: null, briefOpen: false, theme: 'dark' as const, composing: null, setup: [], showDone: false, aside: false, root: '/p', handles: {}, lanes: {},
      agents: [
        agent({ id: 'run', startedAt: 1 }),
        agent({ id: 'done', status: 'completed', endedAt: 5 }),
        agent({ id: 'asks', startedAt: 2 }),
      ],
      inbox: [{ id: 'm', agentId: 'asks', text: 'Ready to merge?', at: 3 }],
    } satisfies View
    expect(rack(v).map(s => [s.agent.id, s.cocked])).toEqual([['asks', true], ['run', false], ['done', false]])
  })
})

describe('what REDhelm brings to Claude Code', () => {
  /** Lets work REDhelm started without awaiting (its start-up, a pressed button) finish. */
  const settle = () => new Promise<void>(r => setTimeout(() => r(), 40))

  const ROWS: any[] = [
    { key: 'switchModelsOnFlag', label: 'x', kind: 'choice', value: 'Switch automatically', options: ['Switch automatically', 'Ask each time'], isLocked: false },
    { key: 'turnDuration', label: 'x', kind: 'boolean', value: false, isLocked: false },
    { key: 'timestamps', label: 'x', kind: 'boolean', value: true, isLocked: false },
    { key: 'inputNeededNotifEnabled', label: 'x', kind: 'boolean', value: false, isLocked: true },
  ]

  test('the setup card offers only what differs and is not locked, and Apply writes it', async ($, on) => {
    const written: Record<string, unknown> = {}
    on('config.list', () => ({ value: ROWS }))
    on('config.set', (_: any, e: any) => ((written[e.key] = e.value), { value: e.value }))
    await engine(on, true)($)
    await settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /Finish setting up REDhelm/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Timestamp every message/ })).toBeUndefined() // already on
    expect(await ui.find({ type: 'Text', text: /phone/ })).toBeUndefined() // locked by policy
    await ui.press({ key: 'setup-apply' })
    await settle()
    expect(written).toEqual({ switchModelsOnFlag: 'Ask each time', turnDuration: true })
    expect(await ui.find({ type: 'Text', text: /Finish setting up REDhelm/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a model switch REDhelm did not see you choose holds prompts and tools until /model', async ($, on) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: {} }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    const sw = (source: string, to: string) =>
      ($ as any).classic.PostModelSwitch({ from_model: 'claude-fable-5-1', to_model: to, requested_model: null, source })

    await sw('auto', 'claude-opus-4-8')
    expect((await $.prompt.submit({ text: 'go on' } as any)).drop).toMatch(/switched models on its own/)
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).deny).toMatch(/held/)

    await sw('picker', 'claude-fable-5-1')
    expect((await $.prompt.submit({ text: 'go on' } as any)).text).toBe('go on')
  })

  test('a session behind the saved default is stopped once, then lets you continue', async ($, on) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: { model: 'claude-opus-6' } }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    await ($ as any).classic.PostModelSwitch({ from_model: 'claude-opus-5', to_model: 'claude-opus-5-5', requested_model: null, source: 'resume' })
    expect((await $.prompt.submit({ text: 'next' } as any)).drop).toMatch(/default is now Opus 6/)
    expect((await $.prompt.submit({ text: 'next' } as any)).text).toBe('next')
  })
})

describe('your REDhelm settings', () => {
  test('missing or unknown values fall back to the defaults', async () => {
    expect(settings()).toEqual({ placement: 'right', statusLine: 'off', guard: 'hold', notifyAfter: 120, autoOpen: true, agentToasts: true })
    expect(settings({ placement: 'left', notifyAfter: -5, autoOpen: false })).toMatchObject({ placement: 'right', notifyAfter: 120, autoOpen: false })
  })

  test('guard "warn" reports a silent switch but never holds your prompt', { options: { guard: 'warn' } } as any, async ($: any, on: any) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: {} }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    await $.classic.PostModelSwitch({ from_model: 'claude-fable-5-1', to_model: 'claude-opus-4-8', requested_model: null, source: 'auto' })
    expect((await $.prompt.submit({ text: 'go on' })).text).toBe('go on')
  })

  test("setup ships REDhelm's status lines into settings.json and keeps the rest of the file", async ($: any, on: any) => {
    let written = ''
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: { statusLine: { type: 'command', command: 'old-line' } } }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'Python 3', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('env.get', () => ({ value: '/h' }))
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: '{"theme":"dark","statusLine":{"type":"command","command":"old-line"}}' }))
    on('fs.write', (_: any, e: any) => ((written = e.text ?? e[1] ?? ''), { value: undefined }))
    await engine(on, true)($)
    await new Promise<void>(r => setTimeout(() => r(), 40))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /under the prompt \(replaces your current one\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /agent panel/ })).toBeDefined()
    await ui.press({ key: 'setup-apply' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    const json = JSON.parse(written)
    expect(json.theme).toBe('dark')
    expect(json.statusLine.command).toMatch(/^python3 ".*\/statusline\/statusline\.py"$/)
    expect(json.subagentStatusLine.command).toMatch(/statusline\/agents\.py"$/)
    await ui.unmount()
  })
})

describe('the bottom bar', () => {
  test('long workspace names shorten to their first words', async () => {
    expect(shortName('Demo app (web folder) — beta')).toBe('Demo app')
    expect(shortName('Game')).toBe('Game')
  })

  test('each workspace reads as a few words', async () => {
    expect(summary({ dir: '/p/game', name: 'Game', lanes: [{ id: 'api', title: 'API', done: 1, total: 2 }] })).toBe('Game 1 of 2 done')
    expect(summary({
      dir: '/p/app', name: 'Demo app (web) — beta',
      board: { stages: ['Done'], rows: [{ id: 'P1', stages: {}, note: '', at: 0 }], total: 4 },
      runs: [{ name: 'demo-run', status: 'ACTIVE', open: 2 }],
    })).toBe('Demo app 1 task open · demo-run active')
  })
})

describe('messaging an agent', () => {
  test('a prompt addressed "→ name: …" goes to that agent, not to Claude', async ($: any, on: any) => {
    const sent: any[] = []
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const r = await $.prompt.submit({ text: '→ docs: please also cover Windows' })
    expect(sent.map(e => [e.to, e.text])).toEqual([['a1', 'please also cover Windows']])
    expect(r.drop).toMatch(/→ docs: sent/)
    expect((await $.prompt.submit({ text: 'an ordinary prompt' })).text).toBe('an ordinary prompt')
  })

  test('Message puts the address in your prompt, where your keyboard already is', async ($: any, on: any) => {
    let filled = ''
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', (_: any, e: any) => ((filled = e.text), { isFilled: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(filled).toBe('→ docs: ')
    await ui.unmount()
  })

  test('an agent named only by a description with a colon still gets its message (the address round-trips)', async ($: any, on: any) => {
    let filled = ''
    const sent: any[] = []
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', (_: any, e: any) => ((filled = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'echo: test target for REDhelm Message', subagentType: 'general-purpose' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    await ui.unmount()
    const r = await $.prompt.submit({ text: `${filled}Hi` })
    expect(sent.map(e => [e.to, e.text])).toEqual([['a1', 'Hi']])
    expect(r.drop).toMatch(/sent/)
  })

  test('an agent that asks you gets a card, and Reply says where to type instead of staying a button', async ($: any, on: any) => {
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', () => ({ isFilled: true }))
    on('session.send', () => ({ isDelivered: true }))
    on('agent.list', () => ({ value: [] }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    await $.session.send({ to: 'lead', text: 'Ready to merge?', agentId: 'a1' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
    expect(await ui.find({ type: 'Text', text: /Asks you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Ready to merge\?/ })).toBeDefined()
    await ui.press({ key: 'compose-a1' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(await ui.find({ type: 'Text', text: /type below · Enter sends to docs/ })).toBeDefined()
    expect(await ui.find({ key: 'compose-a1' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('what REDhelm chooses to show', () => {
  const base = { now: 0, notes: [], inbox: [], guard: {}, inspecting: null, briefOpen: false, theme: 'dark' as const, composing: null, setup: [], showDone: false, aside: false, handles: {}, lanes: {} }

  test("only this session's workflows, or ones an agent here is changing; finished runs stay quiet", async () => {
    const ws = (dir: string, extra: object) => ({ dir, name: dir.split('/').pop()!, ...extra })
    const v = {
      ...base, root: '/p/app',
      agents: [agent({ files: ['/p/lib/util.ts'] })],
      workspaces: [
        ws('/p/app', { board: { stages: ['Done'], rows: [{ id: 'T1', stages: {}, note: '', at: 0 }], total: 3 } }), // here
        ws('/p/lib', { runs: [{ name: 'lib-run', status: 'ACTIVE', open: 1 }] }),                                    // an agent edits it
        ws('/p/other', { runs: [{ name: 'other-run', status: 'ACTIVE', open: 1 }] }),                                // just nearby
        ws('/p', { runs: [{ name: 'old-run', status: 'COMPLETED', open: 0 }] }),                                     // above, but finished
      ],
    } satisfies View
    expect(relevant(v).map(w => w.name)).toEqual(['app', 'lib'])
  })

  test('agents with no name or task get a unique name that is also their address', async () => {
    const one = agent({ id: 'a1697d99', name: '', description: '' })
    const two = agent({ id: 'a9b6863a', name: '', description: '' })
    expect([label(one, {}), label(two, {})]).toEqual(['Agent a169', 'Agent a9b6'])
    expect([handleOf(one), handleOf(two)]).toEqual(['agent a169', 'agent a9b6'])
  })
})

describe('your draft is never sent to an agent', () => {
  test('Message sets an existing draft aside and puts it back after the agent message is sent', async ($: any, on: any) => {
    let box = 'a note I was writing to Claude'
    const sent: any[] = []
    on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
    on('prompt.fill', (_: any, e: any) => ((box = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(box).toBe('→ docs: ')
    await $.prompt.submit({ text: `${box}please also cover Windows` })
    await clock.advance(200)
    expect(sent.map(e => e.text)).toEqual(['please also cover Windows'])
    expect(box).toBe('a note I was writing to Claude')
    await ui.unmount()
  })

  test("a question's card says what the agent is on and when it asked; its sheet has the steps", async ($: any, on: any) => {
    on('session.send', () => ({ isDelivered: true }))
    on('agent.list', () => ({ value: [] }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Choose colors for the settings page', subagentType: 'general-purpose', name: 'asker' })
    await $.tool.call({ tool: 'Edit', file_path: 'src/Button.tsx', old_string: 'a', new_string: 'b', agentId: 'a1' })
    await $.session.send({ to: 'lead', text: 'Should I use blue or green for the save button?', agentId: 'a1' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Asks you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Choose colors for the settings page/ })).toBeDefined()
    const sheet = await openSheet($, ui, 'a1')
    expect(await sheet.find({ type: 'Text', text: /Edit Button\.tsx/ })).toBeDefined() // its recent steps
    expect(await sheet.find({ type: 'Text', text: /Should I use blue or green/ })).toBeDefined()
    await sheet.unmount()
    expect(await ui.find({ type: 'Text', text: /just now/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('two agents with the same name', () => {
  test('get distinct addresses, and Reply goes to the agent whose card you pressed', async ($: any, on: any) => {
    let box = ''
    const sent: any[] = []
    on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
    on('prompt.fill', (_: any, e: any) => ((box = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'asker', subagentType: 'general-purpose', name: 'asker' })
    await $.agent.spawn({ prompt: 'x', description: 'asker', subagentType: 'general-purpose', name: 'asker' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a2')
    await sheet.press({ key: 'compose-a2' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(box).toBe('→ asker a2: ')
    await $.prompt.submit({ text: `${box}yes` })
    expect(sent.map(e => [e.to, e.text])).toEqual([['a2', 'yes']])
    await ui.unmount()
  })
})

describe('waiting is not the same as waiting for you', () => {
  test('an agent that messaged another agent reads "is waiting for <that agent>", with no card for you', async ($: any, on: any) => {
    on('session.send', () => ({ isDelivered: true }))
    on('agent.list', () => ({ value: [{ id: 'a1', name: 'echo', description: 'echo', type: 'general-purpose', status: 'running' }] }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'echo', subagentType: 'general-purpose', name: 'echo' })
    await $.agent.spawn({ prompt: 'x', description: 'asker', subagentType: 'general-purpose', name: 'asker' })
    await $.session.send({ to: 'echo', text: 'are you done?', agentId: 'a2' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /is waiting for Echo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Asks you/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('saying what an agent is doing, truthfully', () => {
  test('an agent with no action for 15 minutes reads as quiet, not as still doing its last thing', async () => {
    const now = 10 * 3600_000
    const busy = agent({ recent: ['exploring'], steps: [{ text: 'Read a.ts', at: now - 60_000 }] })
    const quiet = agent({ recent: ['exploring'], steps: [{ text: 'Read a.ts', at: now - 3 * 3600_000 }] })
    expect(doing(busy, now)).toBe('is reading the code')
    expect(doing(quiet, now)).toBe('has been quiet for 3 h 0 min')
  })
})

