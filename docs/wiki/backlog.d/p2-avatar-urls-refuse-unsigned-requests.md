## P2 - signed avatar URLs, phase 2: refuse an avatar request that carries no token, once the measurement says the old builds are gone

Phase 1 shipped the avatar token ([sessions](../sessions.md#the-avatar-token)): every client builds
its avatar URLs through `avatarUrl(userId)`, which appends `?t=`, and core-service verifies it. A
request carrying NO token is still answered in phase 1 and counted, one `warn` line each:
`[AVATAR_UNSIGNED] via=<nginx|direct> origin=<native|web|none> target=<8 chars>`.

**Phase 2 is one change in `apps/core-service/src/users/avatar-access.ts`**: `unsigned` becomes a
`refused` reason (bodyless `403`, `no-store`, like every other refusal there), the `[AVATAR_UNSIGNED]`
counter goes, and the tests that pin the phase-1 acceptance are turned into refusals. No clock
decides it: the measurement below does.

### The client version floor

**The first stable whose tag contains the merge commit of the phase-1 pull request** (`git tag
--contains <merge sha>`; `1.6.3` at the earliest, whichever stable first carries it). Every build
from that one sends the token. A web tab gets it at its next load after the deploy; the iOS and
Android apps only once the store has delivered that build.

### The measurement that lifts the gate

On production's core-service log, over the 7 days before the phase-2 cut:

- `[AVATAR_UNSIGNED] via=nginx` divided by `[AVATAR]` lines (`grep -c`, per day). It must have fallen
  to the residue of installs that never update - read against the store adoption of the floor
  (`bun tools/play-vitals/vitals.mjs` for Android, App Store Connect for iOS) - and the owner decides
  the residue is acceptable, since phase 2 shows those installs initials until they update.
- `origin=native` and `origin=web` split the residue: a `web` line after the deploy is a page that
  builds the URL by hand (a defect - `avatarUrl.test.ts` should have caught it), not an old build.
- **`[AVATAR_UNSIGNED] via=direct` must be ZERO.** It is a service on the Docker network calling
  without `x-internal-secret`, which no client upgrade fixes. Known caller to check: social-service's
  public roster relay (`GET /api/public/members/:memberId/avatar`, pull request #2954), whose fetch
  to core must send `x-internal-secret` before phase 2 - phase 1 accepts it unsigned.

### Also before phase 2

- **No edge may answer an avatar from its cache without asking core.** A Cache Rule was written
  for this path on the `canari-emse.fr` zone ([core-service](../services/core-service.md#the-avatar-proxy),
  "The edge caches it"), and no token in this project can read a ruleset. Verify with `curl -I` that a request with a fresh
  `t` value, and one with none, reach the origin (`cf-cache-status` not `HIT`) - otherwise an entry
  stored for one URL answers a request the origin would refuse. If it does not, the rule's cache key
  must include the query string, or the rule must leave this path.
- `AVATAR_TOKEN_SECRET` and `DEV_AVATAR_TOKEN_SECRET` provisioned (the deploy refuses to render
  without them, `infrastructure/deploy/env-manifest.tsv`).
