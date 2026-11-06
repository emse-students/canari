# Upstream reachability - the report for a public name whose tunnel has no connector

Built 2026-11-06 for the two silent outages of 2026-11-05: the dev estate's tunnel connector lost every
connection for 25 minutes (Cloudflare `1033` for dev and the legacy name), and the gallery's tunnel had no
connector for five hours (`530` / `1033`, every avatar a `502`). Both were found by hand. Both are the same
shape, so ONE reader asks them all. The edge itself is in [cloudflare-edge](cloudflare-edge.md).

## The mechanism

- `.github/scripts/upstream-reachability-report.sh`, run by the `upstream` job of `scheduled.yml` (no fifth
  workflow: it owns the `*/15 * * * *` slot of the existing one; by hand, dispatch job `upstream`).
- It runs on a GitHub-hosted runner on purpose: the self-hosted runner shares the network whose tunnel may be
  the failure, so it could not tell. The question is what a user's phone asks.
- Targets: the gallery's `/api/health`, and `/api/version` of dev, the legacy name and production. Override
  with `UPSTREAM_TARGETS` (`name|url` lines).
- Each failure is classed, because the cause names who acts: `tunnel-down` (530 + Cloudflare 1033: the
  connector's host), `origin-failing` (other 52x, 502-504: the service behind the name), `unexpected` (any
  other status), `unreachable` (no HTTP answer: a transport failure, never read as health).
- A target is down only when three attempts, ten seconds apart, all fail; a single blink on the runner's side
  is not the estate's fault. A red run is the report, as everywhere in this repository; the first red run in
  `gh run list --workflow scheduled.yml` is the "since when", to within 15 minutes.
- GitHub drops cron slots it misses, so this is a floor, not a guarantee: a late report, never a wrong one.
  Tests: `.github/scripts/tests/upstream-reachability-report.test.sh`.

## What it does not do

- It does not stop the app asking a gallery known to be down. That needs durable state in core-service (set by
  the failure that proves it, cleared by the first success, one probe at a time, one log line per transition)
  and is still owed, as is the same treatment in Le Cercle: see
  [the backlog entry](../backlog.d/p2-the-gallery-went-down-for-five-hours-and-nothing-alerted.md).
- It does not read the connector's own journal (the host's), so it counts loss as seen from outside, not
  connection by connection.

## The transport decision: `--protocol http2` for the dev connector

**Facts of 2026-11-05.** QUIC "timeout: no recent network activity" on all four connections for 25 minutes;
TCP on the same box (the GitHub runner) stayed up; the connector recovered by itself; a sibling VM's L2 showed
periodic unicast loss at the same time. The earlier band of 2026-09-11 also logged
`failed to dial to edge with quic: timeout` ([cloudflare-edge](cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it)).

| | `http2` (TCP) | `auto` (default) |
| --- | --- | --- |
| On the 2026-11-05 path | The transport that stayed up. | The one that failed, for 25 minutes. |
| On a clean path | Slightly higher head-of-line cost; irrelevant for this traffic (dev and a legacy name). | QUIC's best case. |
| Fallback | None needed: there is nothing to fall to. | cloudflared falls back to http2 when QUIC cannot be DIALLED; an ESTABLISHED QUIC session that goes silent is not documented to flip. Treat the fallback as unproven until a lossy window is observed to use it. |
| Reversibility | One flag (or `protocol: http2` in the connector's config); remove it to return to auto. | - |

**Recommendation: `http2` on the connector of the dev estate and the legacy name.** It is the reversible
option, it is the transport with evidence in its favour, and what it gives up (QUIC on a lossy path) is the
property that failed. It is not an owner decision about design; it is a host change, so it is a DSI/owner
action, listed in [the backlog entry](../backlog.d/p2-the-tunnel-connector-lost-every-connection-for-25-minutes.md)
with the steps. Verify afterwards that the connector logs four `protocol=http2` connections, then let the
15-minute report run a week: a 1033 under http2 would refute the transport as the cause.
