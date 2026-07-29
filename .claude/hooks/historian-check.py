#!/usr/bin/env python3
"""
Stop hook: detect canonical-doc changes and remind Claude to invoke @historian.

Commit-aware. Detects watched-path changes from two sources:
  1. Commits landed since the last time the historian ran (tracked via the
     state file the historian advances), and
  2. Uncommitted working-tree changes (inline edits not yet committed).

Why commit-aware: per AGENTS.md, doc-only changes inside docs/ (ADRs, journal,
PRD, agent definitions) get committed directly to main — there's no PR step
to catch them. A working-tree-only hook never fires for that path: by the
time Stop runs, the tree is already clean. The state-file marker lets the
hook see committed work too.

The marker (.claude/.historian-last-seen, gitignored) is ADVANCED BY THE
HISTORIAN after it logs — not by this hook — so the historian's own
journal-entry commit (which touches docs/journal/) doesn't re-trigger the
reminder. This hook only READS the marker, and seeds it once on first run.

No-ops cleanly when:
- Already responding to a previous Stop hook (avoid loops)
- Not inside a git repo
- No new watched commits since the marker AND nothing uncommitted
- Only journal files changed (excluded to prevent self-triggering)
"""

import json
import os
import subprocess
import sys


WATCHED_PREFIXES = (
    "docs/adr/",
    "docs/prd.md",
    "docs/architecture.md",
    "docs/research/",
    "FOLLOWUPS.md",
    "Design Guide.md",
    ".claude/agents/",
    ".claude/skills/",
    ".claude/commands/",
    ".claude/hooks/",
    "AGENTS.md",
    "CLAUDE.md",
)

EXCLUDED_PREFIXES = (
    "docs/journal/",
)

STATE_FILE = ".claude/.historian-last-seen"


def _git(args):
    return subprocess.run(["git", *args], capture_output=True, text=True)


def _read_marker():
    try:
        with open(STATE_FILE) as fh:
            return fh.read().strip()
    except OSError:
        return None


def _write_marker(sha):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as fh:
            fh.write(sha + "\n")
    except OSError:
        pass


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    if data.get("stop_hook_active"):
        return 0

    cwd = data.get("cwd") or os.getcwd()
    try:
        os.chdir(cwd)
    except Exception:
        return 0

    # Must be inside a git repo.
    if _git(["rev-parse", "--git-dir"]).returncode != 0:
        return 0

    head = _git(["rev-parse", "HEAD"]).stdout.strip()
    if not head:
        return 0

    marker = _read_marker()

    # First run after install: seed the marker at HEAD and no-op, so we don't
    # flag the entire pre-existing history as "unlogged."
    if marker is None:
        _write_marker(head)
        return 0

    changed: set[str] = set()

    # (1) Committed changes since the marker.
    if marker != head:
        diff = _git(["diff", "--name-only", f"{marker}..HEAD"])
        if diff.returncode == 0:
            changed.update(diff.stdout.splitlines())
        else:
            # Marker SHA is gone (rebase / amend / fresh clone). Reseed to HEAD
            # and rely on working-tree detection only for this run.
            _write_marker(head)

    # (2) Uncommitted working-tree changes (inline edits not yet committed).
    status = _git(["status", "--porcelain"])
    for line in status.stdout.splitlines():
        if not line.strip():
            continue
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        changed.add(path.strip().strip('"'))

    files = [f for f in changed if f and not f.startswith(EXCLUDED_PREFIXES)]
    material = sorted({f for f in files if f.startswith(WATCHED_PREFIXES)})

    if not material:
        return 0

    file_list = "\n".join(f"  - {f}" for f in material)
    reason = (
        "Historian check: canonical docs changed since the last journal entry:\n"
        f"{file_list}\n\n"
        "Invoke @historian. It will: (1) decide if these are journal-worthy, "
        "(2) write a journal entry, (3) commit and push to origin/main, and "
        "(4) advance its state marker (.claude/.historian-last-seen) to the "
        "new HEAD. If the changes are trivial (typo, reformat, whitespace) "
        "or already logged, the historian says so and advances the marker "
        "without committing — so they aren't re-flagged next turn."
    )

    print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
