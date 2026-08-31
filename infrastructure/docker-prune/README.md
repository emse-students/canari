# Docker prune

**Reclaim what a registry can rebuild. Report, and never delete, what only a human can judge.**

## Why

Checked on 2026-08-27, while asking whether le-cercle's `ENOSPC` could happen here: `canari` held 57
dangling images and 64 dangling volumes, `mitv` held 6 and 77, and **no prune ran at all** on either
host. Neither is near its edge - which is why this is a slope to be measured rather than an incident
to be cleared.

le-cercle fills up for the opposite reason, and the difference decides what may be deleted here. Its
pipeline tags every build `le-cercle:<sha>`; a tag is never dangling, so the `docker image prune -f`
in its deploy reclaimed 0 B for months
([durable-rules](../../docs/wiki/durable-rules.md#shared-gotchas)). Our CD pushes to ghcr and the
compose files pull `:latest`, so the image a deploy replaces **loses its tag** and becomes dangling -
reclaimable by the plainest possible prune, and reconstructible by the next `docker compose pull`.

## What it deletes, and why that list is an allowlist

| Deleted | Command | Why it is safe |
| --- | --- | --- |
| Dangling images | `docker image prune -f` (never `-a`) | an untagged layer set no container runs; `compose pull` rebuilds it |
| Build cache | `docker builder prune -f` | cache, by definition |

**It never deletes a volume and never removes a container.** A dangling volume may be the orphan of a
removed container or may be data whose container is simply not running; `docker volume prune` cannot
tell those apart and neither can a name. An exited container is frequently the only surviving record
of what a volume belonged to, so removing it turns a decidable question into an undecidable one.

The allowlist is a real check in the code - `reclaim()` raises on any kind but `image` and `builder`,
so widening it is an edit somebody has to make on purpose.

## What it reports instead

One JSON line per pass, appended to `/home/canari/docker-prune/passes.ndjson`
(`$CANARI_PRUNE_DIR` overrides the directory), capped at 800 lines by the writer:

| Field | What it separates |
| --- | --- |
| `disk_before` / `disk_after` | the slope itself, on the filesystem holding `/var/lib/docker` |
| `reclaimed[]` | what each prune actually freed - `bytes: null` means docker's output changed shape |
| `dangling_volumes[]` | every volume nothing references, with the evidence below |
| `exited_containers[]` | what a dead stack's volumes point back to |

Each dangling volume carries `project`, `declared_as`, `project_is_live` and `bytes`, which is the
evidence that separates the two causes a reader would otherwise guess between:

- **`project_is_live: false`** - a dead stack. The volume is its data; deleting it is a decision with
  an owner, not a prune flag.
- **`project_is_live: null`** - anonymous. An image declared it, its container is gone, nothing names
  it and nothing will.
- **`project_is_live: true`** - usually just unmounted, and **this is the reading to be careful
  with.** The label names the PROJECT, never the declaration: a service deleted from a live project's
  compose leaves its volume looking owned. `declared_as` is the name to grep the compose file for,
  and the worked example is in this repo's own history - `infrastructure_kafka_data`,
  `infrastructure_zookeeper_data` and `infrastructure_zookeeper_logs` all reported
  `project_is_live: true` on 2026-08-31, months after the broker was removed from
  `docker-compose.prod.yml` and from every service that used to connect to it.

**This repository is public.** The ledger carries names, sizes, labels and timestamps - never the
contents of a mount, never an environment value.

## Running it

```sh
./infrastructure/docker-prune/prune.py --dry-run   # census and print, delete nothing
./infrastructure/docker-prune/prune.py             # reclaim, append a line, print nothing
```

Silence is success. It prints on exactly two occasions, both of which cron captures into the log: a
failure (`docker-prune FAILED: ...` on stderr, exit 1 - a swallowed pass would look like a clean
one), and free space under 15% after reclaiming, which is the point at which the dangling volumes in
the ledger stop being a slope and become the next question.

## Installing it

On `canari`, where `/home/canari/canari` is a checkout CD keeps current:

```cron
# Docker hygiene (05:30) - reclaims images and build cache, reports volumes
30 5 * * * cd /home/canari/canari && ./infrastructure/docker-prune/prune.py >> /home/canari/docker-prune/prune.log 2>&1
```

`mitv` has **no checkout of this repo** - it hosts MiGallery, Sky and the dead `reservation-mitv`
stack. The script is copied there, which means it can drift, which means the copy command belongs
here rather than in somebody's memory:

```sh
scp infrastructure/docker-prune/prune.py mitv:/root/docker-prune/prune.py
ssh mitv 'chmod +x /root/docker-prune/prune.py'
```

```cron
# Docker hygiene (05:45) - see canari:/home/canari/canari/infrastructure/docker-prune/README.md
45 5 * * * CANARI_PRUNE_DIR=/root/docker-prune /root/docker-prune/prune.py >> /root/docker-prune/prune.log 2>&1
```

The two hosts run different docker majors (29 on `canari`, 28 on `mitv`), which is why every label is
read through `docker inspect` and never through `docker ps --format`: docker 29 turned `.Labels`
there into a comma-joined string, so `index .Labels "..."` fails outright on one host and works on
the other.

## Reading the slope

```sh
ssh canari 'tail -5 /home/canari/docker-prune/passes.ndjson' | python3 -m json.tool
```

The number to watch is not the reclaimed bytes - those are noise around a deploy cadence. It is
`dangling_volumes[]` growing without a name being added to `docker-compose.prod.yml`, which means
something is creating anonymous volumes on every restart.
