# Container logs: the ceiling, and what outlives a deploy

**Source**: `x-logging` in `infrastructure/docker-compose.prod.yml`, `docker-compose.dev.yml` and
`authentik/compose.yml`; `infrastructure/lib/archive-logs.sh`, called by
`infrastructure/deploy/deploy-environment.sh`; asserted by
`.github/scripts/tests/compose-logging.test.sh`.

## Two problems, two mechanisms

| Problem | Mechanism | Where |
|---|---|---|
| A container log grows without a ceiling | `json-file`, `max-size: 10m`, `max-file: "3"` on EVERY service, through one `x-logging` anchor | the three compose files |
| A container log dies with its container, and `up -d` recreates containers | `archive_logs` copies every container's log of the project to `~/deploy-log-archive/<project>/<UTC stamp>/<container>.log.gz` just before the first `up -d`; the newest 10 deploys are kept | `infrastructure/lib/archive-logs.sh` |

**Rotation alone fixes only the first.** A rotated log is still a file in the container's own
directory, so recreating the container deletes it. The second mechanism is what keeps evidence
across a release.

## The incident that created this (2026-09-21)

A member could not publish a post from their phone. The investigation read `infrastructure-frontend-1`
and `infrastructure-social-service-1` for the hour, found no `POST /api/posts` and no error, and
concluded the request had never left the device. **That was one step further than the evidence
went**: both containers reported a `StartedAt` of `2026-09-20T21:46:52Z`, so nothing earlier existed
to be read - the hour read was the hour the REPORT arrived in, not the hour of the attempt. The
wrong conclusion was written into a wiki page before it was caught.

Reports arrive hours to days after the fact and deploys are frequent by design, so the default
outcome for a user-reported defect was that its evidence was already gone.

## The mechanism, measured gone (2026-10-08, Portail-etu host, read-only)

- `docker info`: logging driver `json-file`; `/etc/docker/daemon.json` absent.
- `docker inspect` on all 32 running containers: `json-file`, config `map[]` (no `max-size`, no
  `max-file`). The compose files carried no `logging:` stanza.
- No collector container on the box; `journald` has a persistent journal (24 MB) but the deploy user
  (`docker` and `users` groups only) is not in `systemd-journal` and cannot read it, and
  `sudo -n` is refused - so a journald sink would be written and unreadable by the people who need it.
- Log volume: the largest files were Authentik's server (42 MB), Garage prod (46 MB) and Garage dev
  (35 MB); the median is ~0.1 MB; production's `social-service` 108 KB and `core-service` 30 KB.
- Disk: `/` 45 GB, 38 GB used (88 %), 5.5 GB free. `docker system df`: images 12 GB (6.5 GB
  reclaimable), build cache 7 GB (all reclaimable), volumes 1.4 GB.

## Sizing

`3 x 10 MB` per container is 30 MB; one estate of 13 containers is at most ~0.4 GB, against 5.5 GB
free. It is above the median by two orders of magnitude, so a real incident window stays whole, and
it cuts the two 35-46 MB Garage logs. The archive is gzip of what the containers hold at deploy
time (at most 30 MB each, ~10x smaller compressed), times 10 deploys: well under 1 GB, in practice
tens of MB. **Disk is tight (88 %), so the figure to watch is the build cache and unused images
([backlog](../backlog.md), `docker-prune`), not these logs.**

## Reading an archive

```sh
ssh portail-etu-direct
zcat ~/deploy-log-archive/canari-prod/<stamp>/canari-prod-social-service-1.log.gz | grep 'POST /api/posts'
```

The stamp is the moment the deploy STARTED replacing the estate; the archive holds what ran BEFORE
it. Lines carry `docker logs --timestamps`. The live container's log is read with `docker logs` as
before.

## Rules

- A service added to a compose file must carry `logging: *logging`; the self-test derives the service
  list from the file, so a new service without it fails CI.
- A container whose log cannot be read is reported (`::warning::`) and skipped; the other
  containers' logs are still kept. Retention is a COUNT of deploys, never a clock.
- The dev estate shares the host and is archived the same way, under its own project name.
- The change takes effect at the NEXT deploy of each estate: `max-size` is a property of the
  container, applied when `up -d` recreates it. Authentik's compose is not deployed by a pipeline
  (hand-run on the host, [authentik](authentik.md)), so it is bounded when that stack is next
  recreated, and its logs are not archived by the deploy.
