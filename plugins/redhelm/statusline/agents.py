#!/usr/bin/env python3
"""Agent panel rows: prefix every subagent row with the model it's running on.
Yellow ⚠ when that model is another version of the session's (or saved default's)
family — e.g. an Opus 5 agent while the session or default is Opus 5.5."""
import json, os, sys, time

sys.dont_write_bytecode = True  # leave no cache files in the REDhelm folder

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from common import last_main_model, saved_default, short, stale  # noqa: E402

YELLOW, DIM, BOLD, RESET = "\033[1;30;43m", "\033[2m", "\033[1m", "\033[0m"


def elapsed(start_ms):
    s = max(0, int(time.time() - (start_ms or 0) / 1000))
    h, m = divmod(s // 60, 60)
    return f"{h}h {m}m" if h else f"{m}m {s % 60}s"


def tokens(n):
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.1f}k" if n >= 1e3 else str(n or 0)


try:
    inp = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
path = inp.get("transcript_path")
session_model = last_main_model(path) if path and os.path.isfile(path) else None
default = saved_default(inp.get("cwd"))
width = max(40, int(inp.get("columns") or 100))

for t in inp.get("tasks") or []:
    model = t.get("model")
    if not model:
        continue  # nothing to add; keep Claude Code's own row
    what = t.get("label") or t.get("description") or t.get("name") or ""
    when = f"{elapsed(t['startTime'])} · " if t.get("startTime") else ""
    tail = f"  {when}↓ {tokens(t.get('tokenCount') or 0)}"
    tag = short(model) + (f" · {t['effort']}" if t.get("effort") else "")
    warn = stale(model, session_model) or stale(model, default)
    head = f"{YELLOW} ⚠ {tag} {RESET} " if warn else f"{BOLD}{tag}{RESET} "
    room = width - len(tag) - len(tail) - (5 if warn else 1)
    if len(what) > room:
        what = what[: max(0, room - 1)] + "…"
    print(json.dumps({"id": t.get("id"), "content": f"{head}{what}{DIM}{tail}{RESET}"}))
