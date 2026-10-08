#!/usr/bin/env python3
"""Status line: the model that ACTUALLY produced the last main-thread reply.
Red when it differs from the configured model (a switch you didn't make),
yellow when your saved default has moved to another version (stale session)."""
import json, os, sys

sys.dont_write_bytecode = True  # leave no cache files in the REDhelm folder

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from common import base, last_main_model, remember_newest, saved_default, short, stale  # noqa: E402

RED, YELLOW, GREEN, CYAN, DIM, RESET = "\033[1;97;41m", "\033[1;30;43m", "\033[1;32m", "\033[36m", "\033[2m", "\033[0m"

try:
    inp = json.load(sys.stdin)
except ValueError:
    inp = {}
configured = (inp.get("model") or {}).get("id") or ""
name = (inp.get("model") or {}).get("display_name") or short(configured)
path = inp.get("transcript_path")
actual = last_main_model(path) if path and os.path.isfile(path) else None
cwd = (inp.get("workspace") or {}).get("project_dir") or inp.get("cwd")
remember_newest(configured)
default = saved_default(cwd)
level = (inp.get("effort") or {}).get("level")
effort = f" {DIM}·{RESET} {CYAN}{level} effort{RESET}" if level else ""

if actual and configured and base(actual) != base(configured):
    print(f"{RED} ⚠ MODEL MISMATCH: last reply from {actual}, configured {configured} {RESET}", end="")
elif stale(actual or configured, default):
    print(f"{YELLOW} ⚠ STALE: running {short(actual or configured)}, default is now {short(default)} — /model to switch {RESET}", end="")
else:
    print(f"{GREEN}● {name}{RESET}{effort} {DIM}({actual or base(configured)}){RESET}", end="")
