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
   | `edge-refused` | a 4xx the EDGE wrote (`cf-mitigated`, a Cloudflare block or challenge page): the monitor is refused, not the name |
   | `unexpected` | any other status |
   | `unreachable` | no HTTP answer at all: a transport failure, never read as health |

   Every reading carries its evidence (the `server` and `cf-mitigated` headers, the first words of the body).
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
3. GitHub delays and drops cron slots, so the slot is a request, not a promise: a late report, never a
   wrong one. **Measured as `*/15` (2026-11-06 19:19 -> 11-09 06:57 UTC): 13 runs of ~240 slots, 3.4 to 7.2 h
   apart.** The cron is now `4,19,34,49` - off the hour, which is when GitHub says slots are dropped - and the
   delivery is to be re-measured; what reports it if it stays thin is the witness below. A monitor is the deliberate exception in `scheduled.yml` (see its header): it has no other host,
   and a late report beats none. The job has its own concurrency group so a slow run never stacks.

Tests: `.github/scripts/tests/upstream-reachability-report.test.sh` (classes, edge evidence, parallelism, User-Agent) and
`upstream-issues.test.sh` (first failure opens nothing, second opens one, third changes nothing, success closes
with the downtime, non-consecutive failures never alarm, a refused reading is blindness, a refusal is red, a
dry run writes nothing), `upstream-monitor-freshness.test.sh` (the witness below).

## When the monitor is refused

**The defect it closes (2026-11-09).** From the first scheduled run of the default targets (2026-11-06 19:20
UTC) every reading of the gallery, dev and the legacy name was a `403`, while each answered `200` to a phone.
Classed `unexpected`, two readings opened "is down" issues (#3097, #3098, #3099) that no later reading could
close: the issue closes on the first `up`, and from a GitHub-hosted runner there never was one. A dry run
with the evidence column showed the cause: `server: cloudflare`, `cf-mitigated: challenge`, "Just a
moment..." - the zones' bot challenge refusing the runner's network. Production, not behind Cloudflare,
answered `200` throughout.

**What it does now.** Such a reading is `edge-refused`, and `upstream-issues.sh` reports it as what it is:
the monitor is BLIND to that name.

- two consecutive refused readings open **"Upstream monitor cannot read NAME"**, with the evidence; never
  "is down", and never silence - while it is open, an outage of that name is reported by nobody, and the
  issue says so;
- a refused reading neither closes nor confirms an open "is down" issue: it saw nothing;
- any answer the name itself wrote (any class but `edge-refused` and `unreachable`) closes the "cannot read"
  issue with how long the monitor was blind.

**What lifts it is a zone setting, out of the project token's reach**:
[the backlog entry](../backlog.d/p2-the-edge-challenges-the-upstream-monitor.md) carries the options. Working
around the challenge from the probe (a browser User-Agent, a solver) is not an option: it would be a monitor
that lies about how it reads.

## Who watches the monitor

A monitor cannot report its own absence, and neither can anything on the same scheduler. The witness is
`.github/scripts/upstream-monitor-freshness.sh`, run by the `upstream-monitor-freshness` job of `ci.yml` on
every push to `main` (a merge, raised by people and agents, owing nothing to the scheduler). It reads the
monitor's own liveness clock - the completion time of the last SUCCESSFUL `Public names answer` job - and:

- none within **12 hours** opens ONE "Upstream monitor has stopped reading" issue naming the last reading;
- the first push that finds one inside the window closes it;
- a refused `gh` call is red, never "fresh".

12 hours is a report threshold, not a correctness one: above the worst measured gap (7.2 h), so the
scheduler's ordinary drops never alarm, and a monitor gone for half a day always does at the next merge. The
walk over runs stops at the first one older than the window, so its calls are bounded by the window. The
test holds the job name it reads equal to the `upstream` job's.

**A drill** without a real outage: dispatch job `upstream` with `upstream_targets` set to a `name|url` line that
fails (twice, to pass the suspect step) and then to a healthy one. With `dry_run` ticked the decisions are
printed and nothing is written.

## The app does not keep asking a gallery known to be down (2026-11-07)

The report tells people; this half stops the amplification (2 000 `502`s and 4 600 warnings an hour in the
five-hour outage). `apps/core-service/src/users/upstream-health.ts` is the state, `avatar.service.ts` its user:

- **what proves an outage** is decided by ONE classifier (`classifyUpstreamFailure`) used by both paths: no HTTP
  response at all (timeout, transport error) or a gateway/edge status (502, 503, 504, Cloudflare 520-530). Any
  other status (400, 404, 410, 429, a 500 for one record, a redirect) is the gallery ANSWERING about that id and
  proves it is up; a local exception (a cache or `Buffer` fault after an answer) flips nothing. So one bad face
  never blanks a salon's ~30 requests;
- the state is cleared by the FIRST answer of any status, including a late one from a request asked before the flip;
- while down, requests are answered `unavailable` (a `502` `no-store`, so clients draw initials as before)
  without leaving the process, and **probes are spaced by a COUNT of skipped requests** - the n-th probe after
  1, 2, 4 ... skips, capped at 64, reset on recovery. "One probe in flight" alone would not do: Cloudflare's 530
  answers in milliseconds, requests arrive every couple of seconds and rarely overlap, so each would find the
  slot free and ask again (~2 000 asks an hour). Traffic is the clock: 100 sequential requests against a
  fast-failing gallery make 7 calls (spec). A stale cached photo is not served during the outage (it would hide it);
- the transport timeout (axios `timeout`, a socket-inactivity timer) is what bounds a probe, and every path out of
  `admit()` reaches `recordSuccess`, `recordFailure` or `release`, each taking the admission it was given: only the
  PROBE frees the probe slot, so a late failure of a request asked before the flip cannot admit a second probe;
- `avatar-presence` uses the same state and answers `null` while down (clients then ask each avatar, which
  short-circuits); its outage failures log nothing beyond the transition;
- the log carries two transitions: `Avatar gallery <url> is DOWN (<cause>)` and `... is back after Ns - M
  request(s) were answered without asking it`. **To read an outage: grep core-service's log for
  `gallery .* (is DOWN|is back)`.** Every avatar request still writes its ONE `[AVATAR]` line (the signed-avatar
  phase-2 measurement counts them): a skipped one as `outcome=known-down status=502` at info level.
- The state lives in the process (per replica, re-learned by one failed request after a restart): the right
  lifetime for "is this peer reachable from here now".

Tests: `upstream-health.spec.ts` (the state machine), `avatar-outage.spec.ts` (one probe, silence, return line,
presence). Le Cercle's `[MIGALLERY]` fetch needs the same treatment in its own repository, still owed: see
[the backlog entry](../backlog.d/p2-the-gallery-went-down-for-five-hours-and-nothing-alerted.md).

## What it does not do

- It reads the public names from outside; it does not read any connector's own journal.

## The 25-minute tunnel outage of 2026-11-05: cause, and the transport change NOT taken

**Cause (owner, 2026-11-07): an independent technical problem outside the project, not our transport.**
**No transport change is taken**, and the `--protocol http2` recommendation that stood from 2026-11-06 is
withdrawn: nothing shows QUIC was the cause. The watch is the `upstream` job - a `tunnel-down` issue opens one
issue per outage. The analysis below is kept as background only.

**Not taken - why:** the facts below are consistent with a network fault upstream of the connector, which no
choice of transport on our side would have prevented.

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

If `tunnel-down` issues recur from the same connector, this table is where to restart: `http2` is one flag,
reversible, on a connector the project owns.
