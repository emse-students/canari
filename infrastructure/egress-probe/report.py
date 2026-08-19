#!/usr/bin/env python3
"""Answer ONE question from the egress ledger: are the stalls correlated?

`probe.sh` writes a sample a minute. This reads them and prints the only thing that decides between
the two competing explanations for 2026-08-15, when two unrelated upstreams timed out three minutes
apart from two different containers:

  - THE UPSTREAMS. Two independent hiccups that happened to land in one window. Then a slow sample
    for one target says nothing about the others, and the conditional rate below matches the base
    rate.
  - THIS HOST'S EGRESS. One shared path - resolver, conntrack, NAT, the tunnel - stalling for
    everything at once. Then slow samples arrive TOGETHER, and the conditional rate is far above the
    base rate.

A raw count of slow samples cannot separate those, which is why every conditional rate here is
printed next to the base rate it has to beat. A predicate that names an incident is not a predicate
that names the next one until it has been measured against the population it runs on.

Usage:
    ./report.py [/home/canari/egress/samples.ndjson]
"""

import json
import sys
from datetime import datetime, timedelta

# Half the application's 4 s OUTBOUND_BUDGET_MS. A sample this slow has not failed, but it is on the
# way there - and waiting for a failure to call something slow means measuring only the tail.
SLOW_SECONDS = 2.0

HOST_TARGETS = ["wikipedia", "gallery", "self", "control"]


def is_slow(probe):
    """A probe counts as slow when it was slow OR when it did not answer at all.

    Both are the event under study. Separating them is `failures` below; for correlation, an
    upstream that timed out and an upstream that took three seconds are the same observation.
    """
    if probe is None:
        return False
    if probe.get("status") in (0, None):
        return True
    total = probe.get("total")
    if total is None:
        return True
    return total >= SLOW_SECONDS


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round((p / 100.0) * (len(ordered) - 1))))
    return ordered[index]


def rate(numerator, denominator):
    return f"{100.0 * numerator / denominator:5.1f}%" if denominator else "    n/a"


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/home/canari/egress/samples.ndjson"
    samples = []
    malformed = 0
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                samples.append(json.loads(line))
            except json.JSONDecodeError:
                # A truncated line means the probe was killed mid-write. Counted, never silent: a
                # swallowed branch in a best-effort path leaves nothing else behind.
                malformed += 1

    if not samples:
        print(f"no samples in {path}")
        return 1

    first = datetime.strptime(samples[0]["t"], "%Y-%m-%dT%H:%M:%SZ")
    last = datetime.strptime(samples[-1]["t"], "%Y-%m-%dT%H:%M:%SZ")
    expected = int((last - first) / timedelta(minutes=1)) + 1

    print(f"window   {first:%Y-%m-%d %H:%M} .. {last:%Y-%m-%d %H:%M} UTC")
    print(f"samples  {len(samples)} of {expected} expected minutes", end="")
    if len(samples) < expected:
        # A minute with no sample is not nothing: cron did not run, or the probe hung past a minute.
        print(f"  ({expected - len(samples)} MISSING - the probe itself did not answer)")
    else:
        print()
    if malformed:
        print(f"malformed {malformed} truncated lines skipped")
    print()

    print("per target, from the host")
    print(f"  {'target':<12} {'n':>5} {'fail':>5} {'slow':>5} {'p50':>8} {'p95':>8} {'max':>8}")
    for target in HOST_TARGETS:
        probes = [s.get(target) for s in samples if s.get(target) is not None]
        totals = [p["total"] for p in probes if p.get("total") is not None]
        failures = sum(1 for p in probes if p.get("status") in (0, None))
        slow = sum(1 for p in probes if is_slow(p))
        print(
            f"  {target:<12} {len(probes):>5} {failures:>5} {slow:>5} "
            f"{percentile(totals, 50) or 0:>8.3f} {percentile(totals, 95) or 0:>8.3f} "
            f"{max(totals) if totals else 0:>8.3f}"
        )
    print()

    # The container vantage. It differs from the host one by Docker's resolver and the bridge, so a
    # gap between these two lines is a Docker-layer finding rather than an upstream one.
    container = [s.get("wikipedia_container") for s in samples]
    container = [c for c in container if c and c.get("total_ms") is not None]
    if container:
        totals = [c["total_ms"] / 1000.0 for c in container]
        failures = sum(1 for c in container if c.get("status") in (0, None))
        print("same target, from inside chat-delivery-service")
        print(
            f"  {'wikipedia':<12} {len(container):>5} {failures:>5} "
            f"{sum(1 for t in totals if t >= SLOW_SECONDS):>5} "
            f"{percentile(totals, 50):>8.3f} {percentile(totals, 95):>8.3f} {max(totals):>8.3f}"
        )
        print()

    print(f"how many host targets were slow (>= {SLOW_SECONDS:.0f}s or no answer) in the SAME minute")
    histogram = {n: 0 for n in range(len(HOST_TARGETS) + 1)}
    for sample in samples:
        histogram[sum(1 for t in HOST_TARGETS if is_slow(sample.get(t)))] += 1
    for count, minutes in histogram.items():
        print(f"  {count} of {len(HOST_TARGETS)}   {minutes:>6} minutes   {rate(minutes, len(samples))}")
    print()

    print("is one target's stall evidence about another's?")
    print("  a conditional rate far above the base rate means ONE shared path, not two upstreams")
    print(f"  {'given':<12} {'then':<12} {'conditional':>12} {'base':>8}")
    for given in HOST_TARGETS:
        given_slow = [s for s in samples if is_slow(s.get(given))]
        if not given_slow:
            continue
        for then in HOST_TARGETS:
            if then == given:
                continue
            conditional = sum(1 for s in given_slow if is_slow(s.get(then)))
            base = sum(1 for s in samples if is_slow(s.get(then)))
            print(
                f"  {given:<12} {then:<12} {rate(conditional, len(given_slow)):>12} "
                f"{rate(base, len(samples)):>8}"
            )
    print()
    print("nothing above is a verdict until the window is long enough to contain an incident:")
    print("a report over a quiet week says the week was quiet, which was never in doubt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
