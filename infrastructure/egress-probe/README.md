# Egress probe

**One question, and only one: are the outbound stalls CORRELATED?**

## Why

Within one three-minute window on 2026-08-15, two unrelated upstreams timed out from two different
containers - `chat-delivery-service` to Wikipedia at 14:37:02, `core-service` to `gallery.mitv.fr` at
14:39:58. Two upstreams failing at once is not evidence about either upstream, and the first reading
of this shape (an IPv6 problem) was refuted by probing the components, which all came back healthy.

The code half is already done and is not what this is for: `UpstreamUnreachableError` classifies at
the throw so an unreachable host is a 502 `no-store` rather than a remembered 400, and
`OUTBOUND_BUDGET_MS` is set on the `AbortController` **and** on the undici dispatcher, so the stated
budget is the one that fires.

What is owed is a MEASUREMENT, and it is one a component probe cannot make by construction: asked at
any moment, each component says "fine right now". Only a series says whether the stalls arrive
together.

## What it records

`probe.sh` writes one JSON line a minute to `/home/canari/egress/samples.ndjson`:

| Field | From | What it separates |
| --- | --- | --- |
| `wikipedia` | host, curl | the upstream that stalled first |
| `gallery` | host, curl | the upstream that stalled three minutes later |
| `self` | host, curl | `canari-emse.fr/api/version` - the path out through the tunnel and back |
| `control` | host, curl | `1.1.1.1` - whether there was any egress at all |
| `wikipedia_container` | inside `chat-delivery-service`, Node `fetch` | the Docker resolver and the bridge, which the host path does not use |

Each host probe carries `status`, `dns`, `connect`, `tls` and `total` **separately**, because a DNS
stall, a TCP stall and a TLS stall are three different diagnoses and a total cannot tell them apart.
A probe that never got a status is written as `status: 0` with null timings - that sample is the
interesting one, not a gap.

The ledger is capped at 43200 lines (30 days) by the script that writes it, so retention is visible
where the writing happens rather than in a logrotate rule somebody has to find.

**This repository is public**: the sample carries status codes, byte counts and timings only. Never
a body, never a header, never an environment value.

## Reading it

```sh
./infrastructure/egress-probe/report.py
```

It prints, in order: the window and **how many minutes are missing** (a missing minute means the
probe itself did not answer, which is a finding); per-target failure counts and p50/p95/max; how
many targets were slow in the same minute; and the only line that settles the question -

```
  given        then          conditional     base
  wikipedia    gallery             75.0%     1.5%
```

**A conditional rate far above the base rate means one shared path**, not two independent upstreams.
A conditional rate that matches the base rate means the 2026-08-15 window was a coincidence, and the
two upstreams owe nothing to each other. Every conditional is printed next to the base rate it has
to beat, because a predicate that names one incident is not a predicate that names the next one
until it has been measured against the population it runs on.

## Installing

The repository is cloned at `/home/canari/canari` and the probe runs as `canari`, like the backups:

```sh
sudo -u canari crontab -e
```

```cron
# Egress ledger, one sample a minute - WP-EGRESS-1
* * * * * cd /home/canari/canari && ./infrastructure/egress-probe/probe.sh >> /home/canari/egress/probe.err 2>&1
```

`probe.err` should stay empty. Anything in it is the probe failing, which is not the same as an
upstream failing and must not be read as one.

## What this cannot tell you

**Nothing, until the window contains an incident.** A report over a quiet week says the week was
quiet, which was never in doubt. The ledger is worth reading after the next stall shows up in a
service log - that is when the two hypotheses actually differ - and the point of arming it now is
that the stall will already have been measured when it does.
