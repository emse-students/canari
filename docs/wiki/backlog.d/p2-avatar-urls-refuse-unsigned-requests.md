## P2 - signed avatar URLs, phase 2: refuse an avatar request that carries no token, once the measurement says the old builds are gone

target: 1.10.0

Phase 1 shipped the avatar token ([sessions](../sessions.md#the-avatar-token)): every client builds
its avatar URLs through `avatarUrl(userId)`, which appends `?t=`, and core-service verifies it. A
request carrying NO token is still answered in phase 1, and its one `[AVATAR]` line says so:
`[AVATAR] outcome=... access=unsigned via=<nginx|direct> origin=<native|web|none>`.

**Phase 2 is one change in `apps/core-service/src/users/avatar-access.ts`**: `unsigned` becomes a
`refused` reason (bodyless `403`, `no-store`, like every other refusal there), the `via=`/`origin=`
tail goes, and the tests that pin the phase-1 acceptance are turned into refusals. No clock decides
it: the measurement below does.

### The client version floor

**The first stable whose tag contains the merge commit of the phase-1 pull request** (`git tag
--contains <merge sha>`; `1.6.3` at the earliest, whichever stable first carries it). Every build
from that one sends the token. A web tab gets it at its next load after the deploy; the iOS and
Android apps only once the store has delivered that build.

### The measurement that lifts the gate - the owner's decision (2026-11-03)

**Phase 2 ships only when, for 7 CONSECUTIVE days, fewer than 1 % of avatar requests arrive
unsigned, and never before the `1.6.3` stable.** The ratio, per UTC day, on production's
core-service log: `access=unsigned via=nginx` lines divided by all `[AVATAR]` lines (`grep -c`). A
day at or above 1 % restarts the count. Read it against the store adoption of the floor (`bun
tools/play-vitals/vitals.mjs` for Android, App Store Connect for iOS) to say WHO the residue is,
since phase 2 shows those installs initials until they update. Also:
- **Reading, 2026-11-13 (production, 24 h):** 43 unsigned requests out of about 22 700, about 0.19 %,
  under the 1 % threshold. One day of the seven consecutive days required, and phase 2 still waits for
  the `1.6.3` stable and the daily count.
- `origin=native` and `origin=web` split the residue: a `web` line after the deploy is a page that
  builds the URL by hand (a defect - `avatarUrl.test.ts` should have caught it), not an old build.
- **`access=unsigned via=direct` must be ZERO.** It is a service on the Docker network calling
  without `x-internal-secret`, which no client upgrade fixes. The known caller, social-service's
  public roster relay (`GET /api/public/members/:memberId/avatar`, #2954), sends it
  (`internalCoreRequestConfig`; `public.controller.spec.ts`, "carries x-internal-secret when the
  secret is set"; re-read 2026-11-12).
- **The count only sees what reaches core.** On the apps domain the edge answers a cached entry
  without asking the origin (see below), so `access=unsigned` UNDER-counts there: read it as a
  floor, never as the population.

### The cold-avatar cost - owed BEFORE the phase-1 stable

**Re-read 2026-11-12: phase 1 SHIPPED in `v1.6.3` (#2966, `git tag --contains`) without this
reading** - the AV row of [device-verification](../device-verification.md) is NOT-READ (the bench
accounts carry no photo), so the cost below is live in production and the reading is owed before
phase 2 instead, on a bench account given a photo. **This cost starts with phase 1, not phase 2.** The URL carries the viewer's token, so it is
different for every viewer and every UTC day: each viewer's first load of each face each day misses
the edge AND the browser's HTTP cache (a new URL has no entry to revalidate - a full `200` where the
day before a `304` would have answered). The community-open budget is already over on every row
([community-open-budget](../frontend/community-open-budget.md)), so **the Mi 9T reading of a
community open with cold avatars is owed before the phase-1 stable ships**: check AV in
[device-verification](../device-verification.md), on the pre-release.

What already keeps it to once a day: the token is a pure function of (session, UTC day) - a refresh
keeps the session id, so every refresh of the day answers the same token and the same URLs (pinned by
`avatar-access.spec.ts`, "one URL per session per UTC day"), and `userAvatarCache.ts` keys its blobs
by user id, so a warm face survives the token's change. What remains is the first load of each face
per day, and per new session (a sign-in mints a new session id).

### The cold start: no token until the first refresh

A client holds an avatar token only once a sign-in or a refresh has answered one; the token lives in
memory, like the access token. Between a cold start and that first answer, `avatarUrl` builds
unsigned URLs - and so does a session whose token is older than yesterday (the client drops it,
`avatarUrl.ts`). Phase 1 answers both. **Phase 2 would draw initials for exactly that window**, so
before the cut either the faces wait for the first refresh answer, or the token survives the cold
start the way the refresh credential does.
Decide which, and measure the window: the `access=unsigned origin=native` lines of builds above the
floor are this gap and nothing else.

### The edge - read 2026-11-03, and the trade-off it leaves

`curl -I` on `/api/users/<a test account's id>/avatar` (a 404: that account has no photo), with no
`t` and with two different `t` values, read-only:

- `canari.emse.fr` (the web estate): no CDN in front - no `cf-cache-status`, no `Age`. Every request
  reaches nginx, so every request reaches core.
- `canari-emse.fr` (the apps domain, behind Cloudflare): the response is cached at the edge **per
  full URL, query included**. No `t`: `MISS`, then `HIT`. `t=one`: `HIT` (`Age` 7-8 s, from an earlier
  read). `t=two`: `MISS`, then `HIT` (`Age` 0). A real photo answered `HIT` with an `Age` on
  2026-09-22 ([core-service](../services/core-service.md#the-avatar-proxy), "The edge caches it").

What that means, with no change made:

- **The cache key carries the token**, so an entry stored for one URL never answers another URL: a
  refused or forged token can never be served a viewer's cached photo. That is the safe direction.
- **The edge TTL against immediate revocation.** An entry stored for a valid URL is served by the
  edge until it expires, without asking core whether the session is still live. Ending a session
  therefore stops its avatar URLs at the ORIGIN at once, and at the EDGE only after the TTL the Cache
  Rule gives that entry. Only a holder of that exact URL benefits, and it names one face. Phase 2
  must choose: accept that window (and write its length down, read from the rule), or have the rule
  leave this path so every request reaches core.
- **A per-day cold edge against the community-open budget.** The token is per session and per day,
  so each viewer misses the edge once per face per day: the 2026-09-16 rule that cut twenty-four
  round trips to Saint-Etienne (846-946 ms each) to 17-37 ms now serves only a viewer's own repeat
  within a day, not another viewer's request. The browser's HTTP cache (`no-cache` + `ETag`, a
  `304`) and `userAvatarCache.ts` still hold, so the cost is the FIRST open of each face per day.
  Measure it against the 200 ms budget ([community-open-budget](../frontend/community-open-budget.md))
  before phase 2: if it breaks the budget, the answer is a cache key the edge can share (a Cache
  Rule that ignores `t` is NOT that answer - it would hand a cached photo to a request core would
  refuse), not a weaker token.

### The secrets

`AVATAR_TOKEN_SECRET` and `DEV_AVATAR_TOKEN_SECRET` were created by the owner (repo-level, 2026-11-03);
the deploy refuses to render without them (`infrastructure/deploy/env-manifest.tsv`).
