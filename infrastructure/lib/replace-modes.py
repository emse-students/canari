#!/usr/bin/env python3
"""How a release replaces each service of an estate, read from the compose file and REFUSED when unsafe.

Reads `docker compose config --format json` on stdin and prints one line per service, in the order
the deploy must replace them (every service after everything it `depends_on`):

    <service> <mode> <publishes-a-host-port: yes|no> <rotation: proxy:port, or ->

Takes one argument: the image prefix of what THIS repository builds (`<registry>/<owner>/<repo>/`),
because one rule below is about those images and no other.

THE MODE IS DECLARED BY EACH SERVICE, as the label `canari.deploy.replace`, and there is no default:
a default is a policy nobody chose, and both available ones are wrong somewhere - `overlap` on a
service that keeps its state in its own process loses that state, `exclusive` on one that does not
puts every release's outage back. A service added later states its mode on the day it is declared.

  overlap    the new container starts BESIDE the old one and the old one leaves only once the new
             one is healthy. For a service whose every piece of shared state is in Postgres or Redis,
             so that two copies running at once is the same as one.
  exclusive  stopped, then started: a gap. For a service that keeps state in its own process and
             would lose or split it if two ran at once (media-service's metadata index, call-service's
             rooms).
  pinned     brought up as it is; recreated only when its own definition changes (the datastores,
             whose image is pinned by digest, and the edge that holds the host port).

WHAT `overlap` REQUIRES, because each is a way two replicas cannot coexist - and the deploy refuses
rather than discover it on production:
  - no host port: a host port belongs to ONE container, so the second could not start;
  - no volume it could write: two writers on one store is exactly the state `exclusive` exists for.
    A READ-ONLY bind mount is two readers of one file, and is allowed (the rotation file the
    deploy writes for the nginx in front, below);
  - a ROTATION, as the label `canari.deploy.rotation: <proxy service>:<port>`: the nginx that
    routes to this service by an explicit list of replicas the deploy writes, so the old replica
    can be taken OUT of that list - and proven out - before it is told to stop. A replica still in
    rotation when its listener closes resets whatever is queued on it: a 502 on a POST nginx may
    not replay (main CI run 41311303760, 2026-11-01);
  - a compose-level healthcheck WITH `start_interval`: the old replica leaves when the new one is
    `healthy`, so a service with no healthcheck has no moment at which that is known, and without
    `start_interval` Docker runs the first check one full `interval` (30 s) after the start.

WHAT `pinned` REQUIRES: an image this repository does not build. Every release moves the tag of
every image it builds, so such a service is replaced by every release whatever it is called - with
a gap, since nothing overlaps it. Calling it pinned would hide that gap; it is `exclusive`, and says so.

Used by `infrastructure/deploy/deploy-environment.sh` on the resolved file at deploy time, and by
`.github/scripts/tests/deploy-replace.test.sh` on both compose files.
docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to
"""

import json
import sys

LABEL = "canari.deploy.replace"
ROTATION_LABEL = "canari.deploy.rotation"
MODES = ("overlap", "exclusive", "pinned")


def labels_of(service):
    """Compose normalises labels to a mapping, but accepts a list; read both."""
    raw = service.get("labels") or {}
    if isinstance(raw, list):
        return dict(item.split("=", 1) if "=" in item else (item, "") for item in raw)
    return raw


def dependencies_of(service):
    """`depends_on` is a mapping once resolved, a list when hand-written; read both."""
    raw = service.get("depends_on") or {}
    return list(raw) if isinstance(raw, (list, dict)) else []


def writable_volumes(service):
    """Every mount of this service except a read-only bind (which two replicas can share)."""
    out = []
    for volume in service.get("volumes") or []:
        if isinstance(volume, dict) and volume.get("type") == "bind" and volume.get("read_only"):
            continue
        out.append(volume)
    return out


def rotation_of(service):
    """The `proxy:port` this service is routed through, or None."""
    return labels_of(service).get(ROTATION_LABEL)


def refusals_for(name, service, own_prefix, services):
    """Every reason this service cannot be replaced the way it declares, as sentences."""
    mode = labels_of(service).get(LABEL)
    if mode is None:
        return [f"{name}: no {LABEL} label - declare overlap, exclusive or pinned"]
    if mode not in MODES:
        return [f"{name}: {LABEL}={mode} is not one of {', '.join(MODES)}"]
    refusals = []
    if mode == "overlap":
        if service.get("ports"):
            refusals.append(f"{name}: overlap, but it publishes a host port only one container can hold")
        if writable_volumes(service):
            refusals.append(f"{name}: overlap, but it mounts a volume two replicas would both write")
        health = service.get("healthcheck") or {}
        if not health.get("test") or health.get("disable"):
            refusals.append(f"{name}: overlap, but it declares no healthcheck to say when the new replica is ready")
        elif not health.get("start_interval"):
            refusals.append(
                f"{name}: overlap, but its healthcheck has no start_interval - its first check would run one full interval after the start"
            )
    rotation = rotation_of(service)
    if mode == "overlap" and rotation is None:
        refusals.append(
            f"{name}: overlap, but no {ROTATION_LABEL} label names the proxy that routes to it - its old replica could not be taken out of rotation before it stops"
        )
    if rotation is not None:
        proxy, _, port = rotation.partition(":")
        if mode != "overlap":
            refusals.append(f"{name}: {ROTATION_LABEL} on a {mode} service, which is never taken out of rotation")
        if proxy not in services or proxy == name:
            refusals.append(f"{name}: {ROTATION_LABEL}={rotation} names no other service of this file")
        if not port.isdigit():
            refusals.append(f"{name}: {ROTATION_LABEL}={rotation} is not <proxy service>:<port>")
    if mode == "pinned" and str(service.get("image", "")).startswith(own_prefix):
        refusals.append(
            f"{name}: pinned, but its image is built by this repository, so every release replaces it - declare overlap or exclusive"
        )
    return refusals


def replacement_order(services):
    """Every service after everything it depends on; ties broken by name, so the order is stable."""
    order, placed = [], set()
    remaining = sorted(services)
    while remaining:
        ready = [n for n in remaining if all(d in placed or d not in services for d in dependencies_of(services[n]))]
        if not ready:
            raise ValueError("depends_on forms a cycle among: " + ", ".join(remaining))
        for name in ready:
            order.append(name)
            placed.add(name)
        remaining = [n for n in remaining if n not in placed]
    return order


def main(argv):
    if len(argv) != 2 or not argv[1]:
        print("usage: replace-modes.py <image prefix this repository builds, e.g. ghcr.io/owner/repo/>", file=sys.stderr)
        return 2
    own_prefix = argv[1]
    config = json.load(sys.stdin)
    services = config.get("services") or {}
    if not services:
        print("replace-modes: the compose configuration declares no service", file=sys.stderr)
        return 1

    refusals = [line for name in sorted(services) for line in refusals_for(name, services[name], own_prefix, services)]
    if refusals:
        for line in refusals:
            print(f"replace-modes: {line}", file=sys.stderr)
        return 1

    try:
        order = replacement_order(services)
    except ValueError as e:
        print(f"replace-modes: {e}", file=sys.stderr)
        return 1
    for name in order:
        service = services[name]
        ports = "yes" if service.get("ports") else "no"
        print(f"{name} {labels_of(service)[LABEL]} {ports} {rotation_of(service) or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
