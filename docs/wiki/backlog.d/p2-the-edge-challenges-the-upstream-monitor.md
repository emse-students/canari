## P2 - three public names are not watched from outside: the edge challenges GitHub's runners (a gap the lead decides)

target: 1.10.0

**Measured 2026-11-09.** Every reading the `upstream` job of `scheduled.yml` took of the gallery, dev and
legacy names since its first scheduled run (2026-11-06 19:20 UTC, 13 readings out of 13) was a `403`
written by Cloudflare itself: `server: cloudflare`, `cf-mitigated: challenge`, a "Just a moment..." page.
The same URLs answer `200` from a workstation or a phone at the same minute, with the monitor's own
User-Agent too, so the cause is the runner's network (GitHub-hosted runners live in a cloud provider's
address space), not the request. Production (`canari.emse.fr`, not behind Cloudflare) answers the runner
`200`.

**Decided by the owner, 2026-11-09:** nothing is asked of the zones' settings; the project does not depend on a
third party's configuration. **Built:**

- the monitor no longer probes those three names from a runner: they sit in ONE declared list,
  `UNPROBED_FROM_RUNNERS` in `.github/scripts/upstream-reachability-report.sh`, with the reason, printed on
  every default run; every other name is still probed
  ([upstream-reachability](../infrastructure/upstream-reachability.md#when-the-monitor-is-refused));
- a reading the edge refuses stays its own class, `edge-refused`, reported as blindness ("cannot read"),
  never as an outage, for any name that is challenged later;
- the freshness watchdog stays: a push to `main` reports a monitor that stopped reading
  ("Upstream monitor has stopped reading").

**THE GAP, for the lead to decide: an outage of the gallery, dev or the legacy name is now reported by
nothing outside the apps.** What exists: the app's avatar path logs `is DOWN` / `is back` for the gallery
(a log line, no alert), dev's deploy checks that its containers started (at deploy time only), and the
legacy name has no check at all. No existing mechanism alerts anybody for these three. Options, none taken:
a probe from a host of the estate (it cannot watch its own front door, and the host map stays private),
a third-party pinger (an account and a credential outside the repository), or an alert raised from the
production side when the avatar path flips to DOWN (it covers the gallery only).

**Once this is merged, close by hand** #3097, #3098 and #3099 (opened from these 403s before the class
existed, recorded as `unexpected`, saying "down" for names that were up) and any "Upstream monitor cannot
read" issue for those names: nothing probes them any more, so no reading can close them. #3070 is the
monitor's standing state issue and stays open by design.
