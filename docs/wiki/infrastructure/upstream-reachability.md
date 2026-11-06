# Upstream reachability - the report for a public name that stops answering

Built 2026-11-06 for the two silent outages of 2026-11-05 (25 minutes and five hours): each was a public name
whose tunnel had no live connector, which Cloudflare answers `530` with error `1033`. Both were found by hand,
a day late. The edge itself is in [cloudflare-edge](cloudflare-edge.md).

## The mechanism

Two scripts and one job, `upstream` of `scheduled.yml` (no fifth workflow; by hand, dispatch job `upstream`).

1. **The measurement**, `.github/scripts/upstream-reachability-report.sh`. Probes the gallery's health route and
   `/api/version` of dev, the legacy name and production, from a GitHub-hosted runner (the question is what a
   user's phone asks), in parallel, with a recognisable User-Agent. A target is down only when three attempts,
   ten seconds apart, all fail. Each reading is classed because the cause names who acts:

   | class | reading |
   | --- | --- |
   | `up` | 2xx |
   | `tunnel-down` | 530 whose body names Cloudflare's 1033 |
   | `unclassified-530` | 530 without a 1033: read the body |
   | `origin-failing` | other 52x, 502, 503, 504 |
   | `unexpected` | any other status |
   | `unreachable` | no HTTP answer at all: a transport failure, never read as health |

   It exits 0 whatever it finds (a finding is data) and 2 only when it cannot run.
2. **The decision**, `.github/scripts/upstream-issues.sh`. The report is an issue, not a red run: a red
   scheduled run reaches only whoever last edited the cron line, once per slot, where an issue reaches everyone
   watching the repository, once. State is durable on GitHub and no clock is involved:
   - the first failure of a target is only a **suspect**, recorded in the body of ONE standing issue ("Upstream
     monitor state"; editing a body notifies nobody), so a rolling deploy or a dev pre-release landing, each a
     minute of 5xx, never alarms;
   - the second consecutive failure opens **"Upstream NAME is down"**, naming the class, the status and the
     first failed reading;
   - while that issue is open the run stays **green**: one outage is one issue, not twenty emails;
   - the first success comments the downtime and closes it; a success between two failures clears the suspect;
   - the run goes red only when the reporter cannot report: a refused `gh` call or a missing reading.
3. GitHub delays and drops cron slots, so the `*/15` slot is a request, not a promise: a late report, never a
   wrong one. A monitor is the deliberate exception in `scheduled.yml` (see its header): it has no other host,
   and a late report beats none. The job has its own concurrency group so a slow run never stacks.

Tests: `.github/scripts/tests/upstream-reachability-report.test.sh` (classes, parallelism, User-Agent) and
`upstream-issues.test.sh` (first failure opens nothing, second opens one, third changes nothing, success closes
with the downtime, non-consecutive failures never alarm, a refusal is red, a dry run writes nothing).

**A drill** without a real outage: dispatch job `upstream` with `upstream_targets` set to a `name|url` line that
fails (twice, to pass the suspect step) and then to a healthy one. With `dry_run` ticked the decisions are
printed and nothing is written.

## What it does not do

- It does not stop the app asking a gallery known to be down. That needs durable state in core-service (set by
  the failure that proves it, cleared by the first success, one probe at a time, one log line per transition)
  and is still owed, as is the same treatment in Le Cercle: see
  [the backlog entry](../backlog.d/p2-the-gallery-went-down-for-five-hours-and-nothing-alerted.md).
- It reads the public names from outside; it does not read any connector's own journal.

## The transport decision: `--protocol http2` for a tunnel connector that loses QUIC

**Facts of 2026-11-05.** A connector logged QUIC "timeout: no recent network activity" on all its connections
for 25 minutes while TCP traffic from the same machine stayed up, and it recovered by itself. The band of
2026-09-11 also logged `failed to dial to edge with quic: timeout`
([cloudflare-edge](cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it)).

| | `http2` (TCP) | `auto` (default) |
| --- | --- | --- |
| On the 2026-11-05 path | The transport that stayed up; consistent with, not proof of, TCP being the safer carrier on that path. | The one that failed, for 25 minutes. |
| On a clean path | Slightly higher head-of-line cost; irrelevant for this traffic. | QUIC's best case. |
| Fallback | None needed: there is nothing to fall to. | cloudflared falls back to http2 when QUIC cannot be DIALLED; an ESTABLISHED QUIC session that goes silent is not documented to flip. Treat the fallback as unproven until a lossy window is seen to use it. |
| Reversibility | One flag (or `protocol: http2` in the connector's config); remove it to return to auto. | - |

**Recommendation: `http2` on the connector that lost QUIC.** It is reversible, it is the transport that stayed
up, and what it gives up (QUIC on a lossy path) is the property that failed. It is a host change, so an owner
or DSI action, with the steps in
[the backlog entry](../backlog.d/p2-the-tunnel-connector-lost-every-connection-for-25-minutes.md). Afterwards the
`upstream` job is the measurement: a `tunnel-down` issue under http2 would refute the transport as the cause.
