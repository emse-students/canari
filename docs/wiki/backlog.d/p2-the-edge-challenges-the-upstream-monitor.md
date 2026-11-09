## P2 - the edge challenges the upstream monitor, so three of its four names are unwatched (a person with the zones' dashboard must act)

**Measured 2026-11-09.** Every reading the `upstream` job of `scheduled.yml` took of the gallery, dev and
legacy names since its first scheduled run (2026-11-06 19:20 UTC, 13 readings out of 13) was a `403`
written by Cloudflare itself: `server: cloudflare`, `cf-mitigated: challenge`, a "Just a moment..." page.
The same URLs answer `200` from a workstation or a phone at the same minute, with the monitor's own
User-Agent too, so the cause is the runner's network (GitHub-hosted runners live in a cloud provider's
address space), not the request. Production (`canari.emse.fr`, not behind Cloudflare) answers the runner
`200`. Both zones that carry the three names are concerned; [cloudflare-edge](../infrastructure/cloudflare-edge.md)
already records bot detections ON for one of them.

**What the repository did (#this pull request).** The monitor now classes such a reading `edge-refused` and
reports it as BLINDNESS - one "Upstream monitor cannot read NAME" issue - never as an outage and never as
silence ([upstream-reachability](../infrastructure/upstream-reachability.md#when-the-monitor-is-refused)).
That makes the gap visible; it does not close it. **While those issues are open, an outage of the gallery,
dev or the legacy name is reported by nobody.**

**What closes it is a zone setting, which no token of the project can read or change** (the project token
answers `10000` on `bot_management` and `rulesets`, `9109` on the security settings, and has no analytics
read, so the exact rule cannot even be named from here). A person with the dashboard of both zones picks
one, and the next reading closes the "cannot read" issues by itself:

1. **Turn the bot challenge off for these hostnames** (Security > Bots). On a free plan Bot Fight Mode
   cannot be skipped by a custom rule; it is all or nothing per zone. It is also what injects the script
   the dev pages refuse under their CSP, so that page recommends the same gesture.
2. **Or, on a plan whose bot rules can be skipped, a skip rule** for the probed paths only (the gallery's
   health route, `/api/version`), matched on something a scraper cannot guess - not the User-Agent alone.
3. **Not taken: a probe from elsewhere** (a host of the estate, a third-party pinger). The first cannot
   watch its own front door; the second is an account and a credential outside the repository.

**Once the fix is merged, independently of the gesture**: close #3097, #3098 and #3099 by hand. They were opened from these 403s before
the class existed (recorded as `unexpected`), say "down" for names that were up, and a refused reading
rightly cannot close them. #3070 is the monitor's standing state issue and stays open by design.
