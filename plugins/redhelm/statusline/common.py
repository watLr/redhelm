"""Shared helpers for REDhelm's status lines: the model that actually answered, and whether it fell behind your default."""
import json, os, re

TAIL_BYTES = 4_000_000  # only scan the recent part of long transcripts
# Kept outside the REDhelm folder, which ships with no data in it.
NEWEST = os.path.expanduser("~/.claude/redhelm/state/newest.json")
ALIASES = ("opus", "fable", "sonnet", "haiku")  # what the /model picker saves


def base(model):
    """claude-opus-5-5[1m] / claude-opus-5-5-20260901 -> claude-opus-5-5"""
    if not model:
        return ""
    m = model.split("[")[0]
    return re.sub(r"-\d{8}$", "", m)


def family(model):
    """claude-opus-5-5 -> opus, claude-fable-5-1 -> fable"""
    parts = base(model).split("-")
    return parts[1] if len(parts) > 1 and parts[0] == "claude" else base(model)


def short(model):
    """claude-opus-5-5[1m] -> Opus 5.5 (1M)"""
    b = base(model)
    if not b.startswith("claude-"):
        return model or "?"
    fam, *ver = b.split("-")[1:]
    label = f"{fam.capitalize()} {'.'.join(ver)}".strip()
    return label + (" (1M)" if "[1m]" in (model or "") else "")


def stale(actual, default):
    """True when actual is another VERSION of the default's family (opus-5 vs opus-5-5).
    Different families (e.g. a Haiku Explore agent) are deliberate, not stale."""
    return bool(actual and default and family(actual) == family(default) and base(actual) != base(default))


def version(model):
    """claude-opus-5-5 -> (5, 5); claude-opus-5 -> (5,)"""
    return tuple(int(p) for p in base(model).split("-")[2:] if p.isdigit())


def remember_newest(model):
    """Record the newest version seen per family, so a picker alias like "opus" can be
    resolved to a concrete version (the status line calls this with each session's model)."""
    if not (model and model.startswith("claude-")):
        return
    try:
        seen = json.load(open(NEWEST))
    except (OSError, ValueError):
        seen = {}
    fam, cur = family(model), seen.get(family(model))
    if cur is None or version(model) > version(cur):
        seen[fam] = base(model)
        os.makedirs(os.path.dirname(NEWEST), exist_ok=True)
        with open(NEWEST, "w") as f:
            json.dump(seen, f)


def resolve_alias(model):
    if model in ALIASES:
        try:
            return json.load(open(NEWEST)).get(model)
        except (OSError, ValueError):
            return None
    return model


def saved_default(cwd=None):
    """The model new sessions start with: `model` from user < project < local settings.
    A picker alias ("opus") resolves to the newest version of that family seen so far.
    Returns None when unset or unresolvable."""
    paths = [os.path.expanduser("~/.claude/settings.json")]
    d = cwd
    while d and d != os.path.dirname(d):  # nearest project .claude/ walking up from cwd
        if os.path.isdir(os.path.join(d, ".claude")) and d != os.path.expanduser("~"):
            paths += [os.path.join(d, ".claude", "settings.json"), os.path.join(d, ".claude", "settings.local.json")]
            break
        d = os.path.dirname(d)
    model = None
    for p in paths:
        try:
            with open(p) as f:
                model = json.load(f).get("model") or model
        except (OSError, ValueError):
            pass
    model = resolve_alias(model)
    return model if model and model.startswith("claude-") else None


def main_thread_events(path):
    """Yield ("reply", model) and ("model_cmd", None) for the main thread, oldest first."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - TAIL_BYTES))
        lines = f.read().decode("utf-8", "ignore").splitlines()
    for line in lines:
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if not isinstance(o, dict) or o.get("isSidechain"):
            continue
        if o.get("type") == "assistant":
            m = (o.get("message") or {}).get("model")
            if m and m != "<synthetic>":
                yield ("reply", base(m))
        elif o.get("type") in ("user", "system") and "<command-name>/model</command-name>" in line:
            yield ("model_cmd", None)


def last_main_model(path):
    last = None
    try:
        for kind, m in main_thread_events(path):
            if kind == "reply":
                last = m
    except OSError:
        pass
    return last
