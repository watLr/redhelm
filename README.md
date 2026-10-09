# REDhelm

A live sidebar for your Claude Code agents. See what every agent is doing, where its
work is landing, and which one needs you — and know which model is actually answering.

REDhelm borrows one idea from air traffic control's flight progress strips: **every agent
is a strip in a rack, ordered by who needs you next, and a strip that needs you is pulled
out of line.** Only a strip's edge carries its state; the rest stays quiet.

```
REDhelm  3 live · 2 done                Demo app 4 open · release-run active
 ▌ docs     building · Edit setup.md                 Opus 5.5 · xhigh   4m · 133k
▌ api      ◆ Ready to merge?                         Opus 5.5 · high    9m · 201k
```

> **Status: early release (0.3).** The rack, model guard, settings and workflows are
> covered by tests and daily use; **Message**, **Stop** and agent-to-you messages are
> new and not yet field-tested with long multi-agent runs. Issues welcome.

## What it does

- **Agents rack** — one strip per agent: model and effort, what it is doing right now
  (exploring, building, checking), run time and context size. Expand a strip for its
  task, last answer and changed files, with **Message** and **Stop**.
- **Needs you** — an agent waiting on you, or one that sent you a message, is pulled
  out of the rack with its message and a **Reply** button.
- **Where work lands** — changed files grouped by folder, and a warning when two live
  agents are editing the same file.
- **Workflows** — picks up lane boards (`docs/aaa/board/lanes.json`), status boards
  (`.status-board/`), REDStudio (`.redstudio/`) and REDManager (`.redmanager/`) in the
  project and shows their progress.
- **Model guard** — if Claude Code switches models on its own, your next prompt and
  Claude's tools wait until you choose with `/model`. If your saved default moved to a
  newer version, the session tells you once.
- **Long-turn notifications** — a desktop notification (macOS, Linux) when a long turn
  finishes.

## Install

Requires Claude Code with function-hook mods (2.1.289 or newer).

```
claude plugin marketplace add watLr/redhelm
claude plugin install redhelm@redhelm
```

Restart running sessions (`/restart`) to load it.

## Use

| Command | |
|---|---|
| `/redhelm` | Open or close the panel |
| `/redhelm right` · `/redhelm bottom` | Sidebar beside the conversation, or a bar above the prompt |
| `/redhelm setup` | Review the Claude Code settings REDhelm recommends |
| `/redhelm models` | Which models actually answered this session, and recent switches |

The right sidebar needs Claude Code's fullscreen layout (`"tui": "fullscreen"`); in the
classic layout REDhelm opens above the prompt instead.

### Setup card

On first run REDhelm offers a short list of Claude Code settings. Nothing changes until
you press **Apply**:

- Pause instead of switching models when safeguards flag a message
- Show how long each turn took, and timestamp messages
- Push to your phone when a question is waiting (where available)
- A status line with the model that actually answers and its effort, plus model and
  effort on each row of the agent panel (needs `python3`)

### Settings

Every option is a row in `/config`, per user:

| Setting | Values | Default |
|---|---|---|
| Placement | right · bottom | right |
| REDhelm line under the prompt | off · problems · always | off |
| When the model changes without you | hold · warn · off | hold |
| Desktop notification after (seconds) | number, 0 = off | 120 |
| Open REDhelm by itself | on · off | on |
| Pop-ups when agents finish or message you | on · off | on |

## Privacy

REDhelm reads your project folder and Claude Code's own session data on your machine.
It makes no network requests. What it remembers (model switches, the newest model
versions seen, which setup items you handled) stays in Claude Code's plugin storage on
your machine.

## Behaviour notes

- Runs only in interactive sessions; `claude -p`, SDK and other headless runs are left
  untouched.
- If REDhelm itself ever errors, the call it was watching goes through unchanged.

## Develop

```
claude plugin validate plugins/redhelm
claude plugin test plugins/redhelm
```

Load a working copy without installing: `claude --plugin-dir ./plugins/redhelm`.

## License

MIT — see [LICENSE](LICENSE).
