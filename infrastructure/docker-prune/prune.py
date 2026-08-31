#!/usr/bin/env python3
"""One docker hygiene pass: reclaim what is regenerable, REPORT what is not.

WHY THIS EXISTS

Checked on 2026-08-27, `canari` held 57 dangling images and 64 dangling volumes and `mitv` held 6
and 77, because **no prune runs at all** on either host. Neither is near its edge - that is exactly
why this is a slope to be measured rather than an incident to be cleared.

The shape here is the opposite of le-cercle's, and the difference decides what may be deleted. There,
the pipeline tags every build `le-cercle:<sha>`, a tag is never dangling, and the `docker image
prune -f` in its deploy reclaimed 0 B for months. Here CD pushes to ghcr and the compose files pull
`:latest`, so the image a deploy replaces LOSES its tag and becomes dangling - reclaimable by the
plainest possible prune, and reconstructible by the next `docker compose pull`.

WHAT THIS DELETES, AND WHY THE LIST IS AN ALLOWLIST

Two things only, both regenerable from a registry or from source:

  - dangling IMAGES (`docker image prune`, never `-a`) - an untagged layer set no container runs;
  - the BUILD CACHE (`docker builder prune`) - cache by definition.

**It never deletes a volume, and never removes a container.** A dangling volume may be the orphan of
a removed container or may be data whose container is simply not running, and `docker volume prune`
cannot tell those apart - neither can a name. An exited container is often the only surviving record
of what a volume belonged to, so removing it turns a decidable question into an undecidable one.

WHAT IT REPORTS INSTEAD, AND THE EVIDENCE IT CARRIES

Every dangling volume is written to the ledger with the one discriminator that separates the two
causes a human otherwise has to guess between: the `com.docker.compose.project` label, and whether
that project still has ANY container on this host.

  - a project label whose project has no container  -> a dead stack; the volume is its data, and
    deleting it is a decision with an owner, not a prune flag;
  - a project label whose project IS live           -> merely unmounted, USUALLY. Not a proof: the
    label names the project, never the declaration, so a service deleted from a live project's
    compose leaves its volume looking owned. `declared_as` is the name to grep the compose for;
  - no label at all                                 -> an anonymous volume an image declared, whose
    container is gone; nothing names it and nothing will.

Exited containers are listed for the same reason: they are what a dead stack's volumes point back to.

THIS REPOSITORY IS PUBLIC. The ledger carries names, sizes, labels and timestamps - never the
contents of a mount, never an environment value.

Usage:   ./prune.py            (reclaims, appends one ledger line, prints nothing on success)
         ./prune.py --dry-run  (censuses and prints the line, deletes nothing)
Install: see README.md
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone

# One line a day is 365 a year. The cap lives here, where the writing happens, rather than in a
# logrotate rule somebody has to find.
MAX_LINES = 800

# Below this the slope has stopped being a slope. Printing is what cron captures into the log.
FREE_PCT_ALERT = 15

LEDGER_DIR = os.environ.get("CANARI_PRUNE_DIR", "/home/canari/docker-prune")
LEDGER = os.path.join(LEDGER_DIR, "passes.ndjson")

# `docker image prune` and `docker builder prune` both end on this line, and print it even when they
# freed nothing. A run that does NOT print it is a shape change to be recorded, not a zero.
RECLAIMED_RE = re.compile(r"Total reclaimed space:\s*(.+)$", re.MULTILINE)

_UNITS = {"b": 1, "kb": 10**3, "mb": 10**6, "gb": 10**9, "tb": 10**12}

# Docker's Go templates need a literal tab between fields; a space would be ambiguous with a name.
_TAB = "\t"

# The one label that says who owns a volume. Read through `docker inspect`, never through
# `docker ps --format`: docker 29 turned `.Labels` there into a comma-joined STRING, so the
# `index .Labels` that works on 28 fails outright on 29 - and the two hosts run one each.
PROJECT_LABEL = "com.docker.compose.project"

# The volume's name INSIDE that project, which is what a reader greps for in the compose file.
# It is recorded because `project_is_live` alone answers a narrower question than it looks like:
# it says the project has containers, NEVER that the compose still declares this volume. The three
# `infrastructure_{kafka,zookeeper}_*` volumes were the worked example - labelled with a live
# project long after the services that mounted them were deleted from `docker-compose.prod.yml`.
VOLUME_LABEL = "com.docker.compose.volume"

# A Go template indexing a label map that has no such key prints this, not an empty string.
_NO_VALUE = "<no value>"


def docker(*args: str) -> str:
    """Run one docker command and return its stdout. Raises on a non-zero exit."""
    proc = subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=False, timeout=600
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"docker {' '.join(args)} exited {proc.returncode}: {proc.stderr.strip()}"
        )
    return proc.stdout


def parse_size(text: str) -> int | None:
    """Turn docker's human size ("1.159GB", "0B") into bytes. None when it is not one."""
    match = re.fullmatch(r"\s*([0-9.]+)\s*([KMGT]?B)\s*", text, re.IGNORECASE)
    if match is None:
        return None
    return int(float(match.group(1)) * _UNITS[match.group(2).lower()])


def reclaim(kind: str, dry_run: bool) -> dict:
    """Prune one regenerable kind. `kind` is "image" or "builder" - the allowlist is this check."""
    if kind not in ("image", "builder"):
        raise ValueError(f"refusing to prune {kind!r}: only images and build cache are regenerable")
    if dry_run:
        return {"kind": kind, "skipped": "dry-run"}
    output = docker(kind, "prune", "-f")
    match = RECLAIMED_RE.search(output)
    if match is None:
        # The command succeeded and said nothing this parser understands. That is a change in
        # docker's output shape, and silence about it would make every later ledger line unreadable.
        return {"kind": kind, "bytes": None, "raw": output.strip()[-200:]}
    return {"kind": kind, "bytes": parse_size(match.group(1)), "human": match.group(1).strip()}


def volume_sizes() -> dict[str, int | None]:
    """Map volume name -> size in bytes, from the one command that actually computes it."""
    raw = docker("system", "df", "-v", "--format", "{{json .Volumes}}")
    return {entry["Name"]: parse_size(entry.get("Size", "")) for entry in json.loads(raw)}


def clean(field: str) -> str:
    """One inspect field, with the template's own "no such key" spelling read as absent."""
    value = field.strip().lstrip("/")
    return "" if value == _NO_VALUE else value


def inspect(kind: list[str], names: list[str], template: str) -> list[list[str]]:
    """Inspect a batch of objects with one tab-separated template, as rows of fields."""
    if not names:
        return []
    output = docker(*kind, "inspect", "--format", template, *names)
    return [line.split(_TAB) for line in output.splitlines() if line.strip()]


def live_projects() -> set[str]:
    """The compose projects that have at least one container on this host right now."""
    ids = [line.strip() for line in docker("ps", "-q").splitlines() if line.strip()]
    rows = inspect(["container"], ids, '{{index .Config.Labels "' + PROJECT_LABEL + '"}}')
    return {clean(row[0]) for row in rows if clean(row[0])}


def dangling_volumes(sizes: dict[str, int | None], live: set[str]) -> list[dict]:
    """Every volume no container references, each carrying the label that decides its owner."""
    names = [
        line.strip()
        for line in docker("volume", "ls", "-f", "dangling=true", "--format", "{{.Name}}").splitlines()
        if line.strip()
    ]
    template = _TAB.join(
        [
            "{{.Name}}",
            '{{index .Labels "' + PROJECT_LABEL + '"}}',
            '{{index .Labels "' + VOLUME_LABEL + '"}}',
            "{{.CreatedAt}}",
        ]
    )
    volumes = []
    for row in inspect(["volume"], names, template):
        name, project, declared, created = (row + ["", "", "", ""])[:4]
        project = clean(project)
        volumes.append(
            {
                "name": clean(name),
                "created": created.strip(),
                "bytes": sizes.get(clean(name)),
                "project": project or None,
                "declared_as": clean(declared) or None,
                # The discriminator, and it is narrower than it reads. True: the project still has
                # containers - which does NOT mean its compose still declares `declared_as`.
                # False: a DEAD stack's data. None: anonymous, named by nothing and never reclaimed.
                "project_is_live": (project in live) if project else None,
            }
        )
    return volumes


def exited_containers() -> list[dict]:
    """What a dead stack's volumes point back to - which is why this never removes them."""
    ids = [
        line.strip()
        for line in docker("ps", "-a", "-f", "status=exited", "-q").splitlines()
        if line.strip()
    ]
    template = _TAB.join(
        [
            "{{.Name}}",
            "{{.Config.Image}}",
            "{{.State.FinishedAt}}",
            '{{index .Config.Labels "' + PROJECT_LABEL + '"}}',
        ]
    )
    containers = []
    for row in inspect(["container"], ids, template):
        name, image, finished, project = (row + ["", "", "", ""])[:4]
        containers.append(
            {
                "name": clean(name),
                "image": image.strip(),
                "finished_at": finished.strip(),
                "project": clean(project) or None,
            }
        )
    return containers


def disk() -> dict:
    """Free space on the filesystem holding docker's own tree - the number this entry is about."""
    usage = shutil.disk_usage("/var/lib/docker")
    return {
        "total_bytes": usage.total,
        "free_bytes": usage.free,
        "free_pct": round(usage.free * 100 / usage.total, 1),
    }


def append(line: dict) -> None:
    """Append one ledger line, then trim to MAX_LINES. The cap is enforced by the writer."""
    os.makedirs(LEDGER_DIR, exist_ok=True)
    with open(LEDGER, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, separators=(",", ":")) + "\n")
    with open(LEDGER, encoding="utf-8") as handle:
        lines = handle.readlines()
    if len(lines) > MAX_LINES:
        with open(LEDGER, "w", encoding="utf-8") as handle:
            handle.writelines(lines[-MAX_LINES:])


def main() -> int:
    parser = argparse.ArgumentParser(description="Reclaim dangling images and build cache.")
    parser.add_argument("--dry-run", action="store_true", help="census and print, delete nothing")
    args = parser.parse_args()

    try:
        before = disk()
        reclaimed = [reclaim("image", args.dry_run), reclaim("builder", args.dry_run)]
        after = disk()
        live = live_projects()
        line = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "host": socket.gethostname(),
            "dry_run": args.dry_run,
            "disk_before": before,
            "disk_after": after,
            "reclaimed": reclaimed,
            "dangling_volumes": dangling_volumes(volume_sizes(), live),
            "exited_containers": exited_containers(),
        }
    except Exception as error:  # noqa: BLE001 - a swallowed pass leaves nothing behind at all
        # This runs from cron, so printing IS the report: a silent failure looks like a clean pass.
        print(f"docker-prune FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(json.dumps(line, indent=2))
        return 0

    append(line)
    if line["disk_after"]["free_pct"] < FREE_PCT_ALERT:
        print(
            f"docker-prune ALERT: {line['disk_after']['free_pct']}% free on /var/lib/docker after "
            f"reclaiming - the dangling volumes in {LEDGER} are the next question"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
