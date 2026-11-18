#!/usr/bin/env python3
"""Does any service fall back, in its own CODE, to calling a rotated peer by its DNS name?

Reads one estate's `docker compose config --format json` on stdin; argv: the repository root and the
estate's name (for the messages). Prints `ok <message>` / `fail <message>` lines for
deploy-replace.test.sh to count.

WHY (2026-11-07). A call to `http://core-service:3012` resolves through Docker's DNS, which names a
retiring replica until it stops, so the release's take-out never covers it - the reset the mesh exists
to remove (docs/wiki/cicd.md#service-to-service-calls-go-through-the-mesh). replace-modes.py refuses
such a value in the compose file. It cannot see the other way in: a service whose code reads
`process.env.CORE_SERVICE_INTERNAL_URL ?? 'http://core-service:3012'` and an estate that never sets
the variable - the default IS the call, and three services relied on one until this check existed.

So the population is DERIVED, never listed here: every string literal `'<scheme>://<host>:<port>'` in
a service's production sources whose host is a ROTATED service of this estate (one with a
`canari.deploy.rotation` label) must be the default of a chain of variables (`A || B || '...'`,
`A ?? '...'`), and the estate must set at least one of them on that service. replace-modes.py then
holds what it is set to. A literal with no variable in front of it is a call nobody can redirect, and
fails too.

Sources: `apps/<service>/src` for each service of the estate with such a directory, and
`frontend/src` for `frontend-ssr` (the SvelteKit server). Tests (`*.spec.*`, `*.test.*`) are not
production sources. Comments quote URLs in backticks, which the literal pattern does not take.
"""

import json
import os
import re
import sys

ROTATION_LABEL = "canari.deploy.rotation"
SOURCE_SUFFIXES = (".ts", ".js", ".mjs", ".svelte")
# A chain of variables, each followed by `||` or `??`, then a quoted `scheme://host:port`.
DEFAULTED = re.compile(
    r"((?:(?:process\.env\.)?[A-Z][A-Z0-9_]*\s*(?:\|\||\?\?)\s*)*)['\"][a-z]+://([A-Za-z0-9_-]+):([0-9]+)"
)


def labels_of(service):
    raw = service.get("labels") or {}
    if isinstance(raw, list):
        return dict(item.split("=", 1) if "=" in item else (item, "") for item in raw)
    return raw


def environment_of(service):
    raw = service.get("environment") or {}
    if isinstance(raw, list):
        return dict(item.split("=", 1) if "=" in item else (item, "") for item in raw)
    return raw


def production_sources(root):
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = [d for d in subdirectories if d not in ("node_modules", "dist", "build")]
        for name in sorted(files):
            if not name.endswith(SOURCE_SUFFIXES) or ".spec." in name or ".test." in name:
                continue
            yield os.path.join(directory, name)


def main(argv):
    repo, estate = argv[1], argv[2]
    services = json.load(sys.stdin)["services"]
    rotated = {name for name, service in services.items() if ROTATION_LABEL in labels_of(service)}
    seams = [(name, os.path.join(repo, "apps", name, "src")) for name in sorted(services)]
    seams.append(("frontend-ssr", os.path.join(repo, "frontend", "src")))
    found = 0
    for service, root in seams:
        if service not in services or not os.path.isdir(root):
            continue
        environment = environment_of(services[service])
        for path in production_sources(root):
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            where = os.path.relpath(path, repo).replace(os.sep, "/")
            for match in DEFAULTED.finditer(text):
                chain, host = re.findall(r"[A-Z][A-Z0-9_]*", match.group(1)), match.group(2)
                if host not in rotated or host == service:
                    continue
                found += 1
                if not chain:
                    print(f"fail {estate}: {where} calls {host} by its DNS name with no variable in front - nothing can route it through its rotation")
                elif any(variable in environment for variable in chain):
                    print(f"ok {estate}: {service} sets {' or '.join(chain)}, so {where} never falls back to {host} by its DNS name")
                else:
                    print(f"fail {estate}: {service} sets none of {', '.join(chain)}, so {where} calls {host} by its DNS name, around its rotation")
    # A pattern that matched nothing proves nothing: the seams exist today, and finding none means the
    # pattern and the code have diverged.
    if found == 0:
        print(f"fail {estate}: no defaulted internal URL found in any source - the pattern no longer matches the code")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
