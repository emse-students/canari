# Container logs: the ceiling, and what outlives a deploy

**Source**: `x-logging` in `infrastructure/docker-compose.prod.yml`, `docker-compose.dev.yml` and
`authentik/compose.yml`; `infrastructure/lib/archive-logs.sh`, called by
`infrastructure/deploy/deploy-environment.sh`; `infrastructure/lib/log-retention.sh` and
`infrastructure/deploy/log-retention-report.sh`, run daily by `scheduled.yml`'s `log-retention` job;
asserted by `.github/scripts/tests/compose-logging.test.sh` and `log-retention.test.sh`.

## Two problems, two mechanisms

| Problem | Mechanism | Where |
|---|---|---|
| A container log grows without a ceiling | `json-file`, `max-size: 10m`, `max-file: "3"` on EVERY service, through one `x-logging` anchor | the three compose files |
| A container log dies with its container, and `up -d` recreates containers | `archive_logs` copies the last 30 days of every container's log of the project to `~/deploy-log-archive/<project>/<UTC stamp>/<container>.log.gz` just before the first `up -d`; the newest 10 deploys are kept, and none older than 30 days | `infrastructure/lib/archive-logs.sh` |
| The privacy policy promises IP logs are kept 90 days at most, and a size cap is no bound in time | archives pruned by AGE at every deploy and daily; a live log holding a line older than 60 days turns the daily run red | [below](#the-90-day-ceiling-2026-10-16) |

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

## The mechanism, measured gone (2026-10-08, production host, read-only)

- `docker info`: logging driver `json-file`; `/etc/docker/daemon.json` absent.
- `docker inspect` on all 32 running containers: `json-file`, config `map[]` (no `max-size`, no
  `max-file`). The compose files carried no `logging:` stanza.
- No collector container on the box, and a journald sink would be written and unreadable by the
  deploy account that needs it.
- Log volume: the largest files were Authentik's server (42 MB), Garage prod (46 MB) and Garage dev
  (35 MB); the median is ~0.1 MB; production's `social-service` 108 KB and `core-service` 30 KB.
- Disk: nearly full (88 %). `docker system df`: images 12 GB (6.5 GB
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
# on the production host
zcat <archive-root>/canari-prod/<stamp>/canari-prod-social-service-1.log.gz | grep 'POST /api/posts'
```

The stamp is the moment the deploy STARTED replacing the estate; the archive holds what ran BEFORE
it. Lines carry `docker logs --timestamps`. The live container's log is read with `docker logs` as
before.

## Rules

- A service added to a compose file must carry `logging: *logging`; the self-test derives the service
  list from the file, so a new service without it fails CI.
- A container whose log cannot be read is reported (`::warning::`) and skipped; the other
  containers' logs are still kept. Retention is a COUNT of deploys AND an age: the count is what the
  evidence needs, the age is what the privacy policy allows, and the stricter one wins.
- The dev estate shares the host and is archived the same way, under its own project name.
- The change takes effect at the NEXT deploy of each estate: `max-size` is a property of the
  container, applied when `up -d` recreates it. Authentik's compose is not deployed by a pipeline
  (hand-run on the host, [authentik](authentik.md)), so it is bounded when that stack is next
  recreated, and its logs are not archived by the deploy.

## The 90-day ceiling (2026-10-16)

**The promise**, `frontend/src/routes/legal/privacy/+page.svelte`: *"Logs techniques (IP,
horodatage) - Conservés au maximum 90 jours à des fins de sécurité, puis supprimés
automatiquement."* Until this date nothing enforced it.

**What carries a client address here.** No first-party service except the frontend container's
nginx: the access log
(`canari_redacted`, `infrastructure/local/Dockerfile.frontend`, real client address since
`real_ip` of 2026-09-30) and the error log (`client: <ip>`). Both go to stdout/stderr - the stock
image symlinks `/var/log/nginx/*.log` there - so no log FILE is written inside any container, and
they live in the container log and its archives. No NestJS or Rust service logs an address (swept
2026-10-16: no logger line names `ip`, `X-Real-IP` or a peer address). The other services' logs
carry user ids, which is why the ceiling is applied to every container, not only the frontend.
Third-party containers of the estate log PEER addresses of their own - garage's S3 request lines,
adminer's `php -S` access lines, postgres connection logs when `log_connections` is on - which
today are container-network addresses, not clients; the ceiling below covers every container
regardless.

### The access log diagnostic fields (2026-10-18)

Five fields trail the `canari_redacted` line, added to explain an intermittent Messenger preview
failure the log could not: `rt=` total request time, `urt=` the upstream's response time, `ust=` the
upstream's status (`-` when nginx answered from disk), `ce=` the `Content-Encoding` of THIS response
(`gzip` or `-`), and `deg=` the `X-Canari-Degraded` header (`1` when the SSR served a degraded head,
`ssr-unavailable` when nginx fell back to the app shell). They are durations, statuses and one header
value: no address, cookie or query is added, so the 90-day ceiling and the privacy policy are
unchanged. `access-log-redaction.test.mjs` asserts the five are present and that no cookie or
authorization variable ever enters the format. Reading them: a crawler hit with `deg=1` is the SSR's
own admission; `urt` near 1.5 s with `deg=-` is a slow enrichment that still answered; `ust=502` with
`deg=ssr-unavailable` is the container down.

**A SIZE CAP IS NOT AN AGE CAP.** `max-size: 10m` / `max-file: "3"` bounds the bytes, so the oldest
line held is the one written 30 MB ago. A busy container rolls that over in minutes
([backlog](../backlog.md), the 2026-10-12 decision row); a quiet one - postgres, redis, garage, the
dev estate, any estate over the summer - holds months, and a deploy recreates only the services
whose image changed. Docker has no time-based rotation, and only removing the container deletes
its log. So there is no proof from the size cap, and none is claimed.

**What is enforced, and what is only reported.**

| Where | Bound | Mechanism |
| --- | --- | --- |
| The deploy-log archive | an archive holds at most the 30 days before its deploy (`docker logs --since 720h`) and is deleted at 30 days, so a line lives at most 60 days + the gap between two prunes | `prune_log_archive`, at every deploy (`archive_logs`) and daily (`log-retention-report.sh`); allowlist: only a directory named like a stamp it writes is ever removed, anything else is reported |
| A live container log | **REPORTED, not enforced**: a line older than 60 days turns the daily run red, naming the container and the line's date; one older than 90 days is reported as the promise broken | `report_live_log_age` asks each log `docker logs --until 1440h` - the log itself is the evidence, so a busy container whose rotation already dropped its old lines is not reported |
| `auth_sessions."lastIp"` / `"userAgent"` | at most 7 days + 1 hour old | every write of `lastIp` moves `expiresAt` to `SESSION_TTL_SECONDS` later in the same statement, and the hourly sweep deletes the row past it - no job of its own, asserted in `auth-sessions.service.spec.ts` |
| The nightly backup archive (`postgres_auth_db.sql.gz` holds `auth_sessions`) | up to ~16 days offsite (`BACKUP_RETENTION_DAYS=14` with `find -mtime +14`, which deletes a file once it is 15 whole days old, at the next nightly run) and ~9 days locally (`LOCAL_RETENTION_DAYS=7`, since 2026-10-24), + the 7-day row bound | `backup.sh`, locally and on `mitv`; restic holds only object volumes, no log and no IP ([backup](backup.md)) |

**Why the live half is a report.** The only operation that deletes a live line is recreating its
container, which on production is a restart nobody watches. Automating it was drafted on
2026-10-16 and stopped before it was written, as an unattended production change the user has not
approved; it is a [backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)
decision. Until it is taken, a red `log-retention` run is acted on by hand:

```sh
# on the production host
cd <deploy-path>   # the dev estate's path and docker-compose.dev.yml for dev
TAG=<the tag the estate runs> docker compose -f infrastructure/docker-compose.prod.yml \
  --env-file infrastructure/.env up -d --no-deps --force-recreate <service>
```

after archiving it like a deploy would (`. infrastructure/lib/archive-logs.sh && archive_logs docker canari-prod "$LOG_ARCHIVE_ROOT" 10`).

**The bound, honestly.** The archive is bounded at 60 days plus the gap between two prunes; the
prune runs at every deploy and daily on a GitHub schedule, which delays and drops slots (measured
up to 12 h late, `scheduled.yml`'s header), so the 30 days between 60 and 90 are the slack for
that, not a guarantee. The live logs are bounded only once a human acts on the red run, within the
30 days the report leaves. **Nothing on the shared host is bounded by this repository** - its
journal, reverse proxy, intrusion-prevention, file-integrity and endpoint agents are the host owner's, and the request is
[dsi-log-retention-request](dsi-log-retention-request.md).

**Verify.**

```sh
gh run list --workflow scheduled.yml --limit 5          # the log-retention job, daily
gh workflow run scheduled.yml -f job=log-retention      # by hand
ls <archive-root>/canari-prod/   # on the production host: no stamp older than 30 days
```
