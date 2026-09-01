# The dev environment (`dev.canari-emse.fr`)

A second, complete Canari estate, running on the SAME machine as production, reachable at
`dev.canari-emse.fr`. Its purpose is to be the place where a change can be observed before members
see it - and, specifically, to be the only honest rehearsal ground for the class of failure that took
production down on 2026-09-01, when an auto-merged `postgres 15-alpine -> 18-alpine` refused
production's data directory.

This page is the only copy of how the environment is put together. The decisions behind it - taken
with the user on 2026-09-01 and marked not to be re-litigated - are in
[backlog](../backlog.md); the merge-ceiling half is on [cicd](../cicd.md); the cookie half is on
[sessions](../sessions.md).

**IT DOES NOT EXIST YET.** Every mechanism described below is built, tested and committed, but
nothing deploys it: the CD wiring is sequenced last on purpose (see
[what is still owed](#what-is-still-owed-and-by-whom)). Until then production is the only
environment, and every default here is chosen so that absence reads as production.

---

## 1. What keeps it apart from production

Two independent mechanisms, and the distinction matters because only one of them is enforced by
Docker.

**By compose project - structural.** The estate is deployed as the compose project `canari-dev`
against [`infrastructure/docker-compose.dev.yml`](../../../infrastructure/docker-compose.dev.yml);
production is the project `infrastructure`. A compose project gets its own network and its own named
volumes, so a dev container cannot resolve a production service by name and cannot mount a
production volume. This is not configuration a value can get wrong.

**By value - conventional.** Every `${...}` in the dev compose file is filled from the dev
environment's own secrets: its own `JWT_SECRET` (so a token minted by one environment is refused by
the other), its own Garage keys and bucket, its own Authentik client. Beyond those, the file is
deliberately identical to production, so that a difference in observed behaviour is never explained
away by a difference in configuration.

### The two host ports that differ, and why only two

Production publishes **no** host port for any internal service - it uses `expose:`, which is
container-side only. So there is nothing for a second project to collide with, and the offsets the
first version of this file carried were unnecessary. Exactly two bindings differ, both loopback-only:

| | production | dev | why it is published at all |
|---|---|---|---|
| `frontend` | `8080` | `3080` | the cloudflared tunnel reaches Nginx through the host |
| `garage` API / admin | `19010` / `19011` | `19100` / `19101` | tooling (`garage` CLI) attaches from the host |

**A CONTAINER-SIDE ADDRESS IS NEVER OFFSET.** The version of the dev compose file replaced on
2026-09-01 had never worked, for exactly this reason: it applied the host offsets to the container
addresses too - `redis://redis:6380`, `postgres://...@postgres:5433/auth_db`,
`http://core-service:3112`, `DB_PORT: "5433"`. Inside a compose network a service answers on the
port it LISTENS on; the number left of the colon in `ports:` exists only on the host and is
invisible to peers. Every one of those URLs pointed at a closed port.
[`compose-wiring.test.sh`](../../../.github/scripts/tests/compose-wiring.test.sh) now derives the
service list from the compose file itself and fails if any internal URL names a port the target does
not listen on.

### Resource ceilings, not reservations

`x-dev-limits` caps every dev container at 1 CPU and 768 MB. Dev shares a host with production, and
the point of the cap is that a dev container which misbehaves cannot starve the estate real members
use. It is a ceiling deliberately, not a reservation: dev must never hold capacity production is
short of.

---

## 2. Dev runs in production mode, and that is the whole point

Six services in the dev compose file set `NODE_ENV: production` - the four NestJS ones plus
`frontend` and `frontend-ssr` - and each is PINNED there rather than inherited from `.env` the way
production allows. Dev is a live HTTPS environment behind the same tunnel and the same Nginx as
production; running it in development mode would make it a different program, which defeats the
reason it exists.

That has one consequence worth stating, because it was a defect before it was a rule. The refresh
cookie's `Secure` and `SameSite` attributes used to be chosen per request, by sniffing the `Origin`
header - so an environment that forgot to declare itself would have issued the refresh cookie
without `Secure` over HTTPS. The attributes are now a deployment fact, read once at construction
from `ALLOW_INSECURE_COOKIES`, which has **no default**: with `NODE_ENV=production` the value `true`
is a startup ERROR, and with any other `NODE_ENV` an unset value is also a startup error. The only
place `true` belongs is [`infrastructure/local/docker-compose.yml`](../../../infrastructure/local/docker-compose.yml),
the plain-HTTP local stack. The reasoning is on
[sessions](../sessions.md#the-cookies-own-attributes-are-a-deployment-fact-not-a-per-request-one).

---

## 3. The data: a full copy of production, and the three things it must not carry

[`infrastructure/dev/copy-prod-to-dev.sh`](../../../infrastructure/dev/copy-prod-to-dev.sh) dumps
production's `auth_db`, restores it over dev's, strips what must not travel, and then VERIFIES rather
than asserting.

**Why a full copy.** Decided with the user against the recommendation, for usability: an empty dev
environment is one nobody can log into or interact with meaningfully. Two facts were put to the user
first and did not change the decision - the server holds only ciphertext, so copied conversations are
UNREADABLE on a fresh dev client (the MLS keys live on the device, the media CEK is
client-generated), and login ease comes from the Authentik directory rather than from this database.
So the copy buys realistic users, communities, posts, forms, calendar and shop, and nothing at all
for chat. It also buys the thing that matters most for the ceiling: a dev Postgres holding a data
directory really written by production's 15.

**The direction cannot invert, and that is enforced rather than documented.** Every destructive
statement goes through `dev_sql()`, which re-reads the target container's
`com.docker.compose.project` label and refuses unless it is exactly `canari-dev`. The two project
names are hardcoded constants, not parameters, so there is no argument a caller can pass to point the
script at production - an ALLOWLIST of what may be written to, which is what a destructive control
needs. Containers are found by compose LABEL and the database user is read from the container's own
environment, so the script needs no compose file, no `.env` and no path to be correct.

**The strips**, each reporting what it changed, because the failure mode of this block is an absence:

| | what | why |
|---|---|---|
| (a) | `TRUNCATE push_token` | the rows belong to production's FCM sender and to real devices. A shared sender would deliver a test notification to a member's phone; a dev sender rejects every row, which is 70-odd logged failures per send |
| (b) | 7 payment columns across 4 tables | there is no Stripe and no Lydia in dev at all, so each is a live identifier with no credential behind it. It is seven, not the five the plan first named, because `associations` carries a Lydia pair beside the Stripe pair |
| (c) | `platform_config.payment_provider` left ALONE | its type is `'stripe' \| 'lydia'` with no third value, so nothing can say "payments are off". Writing anything else would contradict what the code asserts about the column |

(c) is a recorded gap, not an oversight: dev presents Stripe as the live provider and fails on use.
That the platform cannot declare payments disabled is in [backlog](../backlog.md).

[`dev-copy-guards.test.sh`](../../../.github/scripts/tests/dev-copy-guards.test.sh) DERIVES the
column list in (b) from the entity declarations and fails if a payment column is added without being
stripped, so a schema change cannot disarm the step silently.

---

## 4. The version gap, and the one kind of evidence that lifts a ceiling

Dev is the environment where a major version is allowed to run ahead of production, and
[`infrastructure/dev/version-gap.yml`](../../../infrastructure/dev/version-gap.yml) is where that
gap is DECLARED. The auto-merge ceiling reads it: a stateful image whose major bump is refused for
production has that refusal retired only by a row here recording the rehearsal.

**A green dev deploy is NOT that evidence**, and this is the correction that matters most on this
page. The copy above is a `pg_dump`/restore, so a new major initialises its own cluster from empty
and structurally CANNOT fail the way production failed on 2026-09-01. Accepting a green dev deploy as
proof would have re-armed that 33-minute outage behind a gate that reads as a proof. Hence four
`evidence` values, of which only `in_place_upgrade` - the new major started on a BINARY copy of
production's `PGDATA` - lifts anything. The table is on
[cicd](../cicd.md#a-refusal-is-retired-by-a-declared-gap-in-dev-and-exactly-one-kind-of-evidence-counts),
the only copy.

All three rows read `evidence: none` today. [`dev-gap.test.sh`](../../../.github/scripts/tests/dev-gap.test.sh)
derives the row set from production's compose file, holds each declared major against both compose
files, and asserts the ceiling's verdict agrees with the row.

---

## 5. How a dev deployment identifies itself

Two variables, and the split between them is deliberate.

**`VITE_DEPLOY_ENVIRONMENT`** - build-time, frontend. `development` or `dev` renders a permanent,
non-dismissible "test environment" banner
([`EnvironmentBanner.svelte`](../../../frontend/src/lib/components/shared/EnvironmentBanner.svelte)).
It is build-time so the banner is up before the first request and stays up when the API is
unreachable; it is not derived from the hostname because a hostname rule needs editing for every name
added and cannot answer at all for the mobile app, whose origin is `tauri://localhost` in every
environment. **Unset means production, and so does any value nobody planned for** - the failure mode
of a missing or misspelt variable is then a MISSING banner on a test box, which whoever is looking at
it can see, rather than a banner shown to every member of production. An unrecognised label is never
rendered raw, because the text is localised.

The banner cannot be dismissed, and that is the point: dev carries a full copy of production, so it
is indistinguishable from production on screen. A banner that could be closed would be closed in the
first session and never seen again.

**`DEPLOY_BUILD`** - runtime, backend. Reported by `/api/version` as its own field, `build`, beside
`version`. **It must never be folded into `version`.** Clients DECIDE on that field: `compareSemver`
parses it, `releaseTag` turns it into `vX.Y.Z`, and `getReleaseApkDownloadUrl` builds a GitHub
download URL from it - so a `version` of `0.14.15+dev.abc1234`, which is how the plan first described
this, would have offered every dev client an update from a tag that does not exist, i.e. a 404 behind
the update button. A build identity is REPORTING; a version is DECIDED on.
[`version.service.spec.ts`](../../../apps/core-service/src/version/version.service.spec.ts) asserts
`version` stays a bare semver while `build` carries the suffix.

Both variables are written by no pipeline yet. Until the CD wiring lands, the banner does not show
and `build` is null - the correct behaviour for production, the only environment that exists.

---

## 6. What is deliberately absent

| | state | why |
|---|---|---|
| Stripe / Lydia | no credentials, identifiers stripped | user, 2026-09-01: dev will not reach Stripe for now |
| Push notifications | no dev FCM project yet | owed by the user; production's sender must not be shared |
| Mobile builds | phase 2 | a dev keystore and a dev Firebase project are prerequisites |
| A `dev` branch | none, by decision | dev deploys from `main`, so what is on dev is what is on `main` |

---

## 7. The tests that hold this together

Run by `make test-ci-scripts`, which is a CI job:

| suite | what it derives, so omission cannot pass |
|---|---|
| [`compose-wiring.test.sh`](../../../.github/scripts/tests/compose-wiring.test.sh) | the service list and its listening ports from the compose files; the NestJS app list from `apps/*/package.json` declaring `@nestjs/core`, each of which must set `NODE_ENV` |
| [`dev-copy-guards.test.sh`](../../../.github/scripts/tests/dev-copy-guards.test.sh) | the payment columns from the entity declarations |
| [`dev-gap.test.sh`](../../../.github/scripts/tests/dev-gap.test.sh) | the row set from production's compose file's named stateful images |
| [`ceiling.test.sh`](../../../.github/scripts/tests/ceiling.test.sh) | the stateful image names from `docker-compose.prod.yml` |

Every one of them reads its subject from a source of truth rather than a hand-written list, for the
same reason: the failure mode of a guard list is an ABSENCE, and an absence in a hand-written list
passes silently.

---

## What is still owed, and by whom

The tracked items live in [backlog](../backlog.md); this is the map.

**Owed by the user** - credentials nothing here can create:

- the Cloudflare Access service token for the harness (needs `Account -> Cloudflare Tunnel` plus the
  two account-scoped Access permissions)
- a dev Firebase project, for push
- a dev Android keystore, and where it is backed up

**Owed by the CD wiring**, sequenced last on purpose - editing production's CD before dev serves
anything is how a third outage happens:

- unify `cd.yml` into one environment-parameterised workflow and delete the dormant `cd-dev.yml`
  (734 lines wired to production secrets)
- the dev-before-prod migration gate
- write `VITE_DEPLOY_ENVIRONMENT` and `DEPLOY_BUILD`
- the copy workflow's trigger

**One tunnel ingress edit**: repoint `dev.canari-emse.fr` at `http://localhost:3080`. GET the
config, save the original, change the single rule, PUT - never probed by writing.

**One thing that cannot be verified until Access exists.** The campaign harness must reach dev
freely (user, 2026-09-01), and it drives real Chrome over CDP rather than Playwright - so the
mechanism is `Network.setExtraHTTPHeaders` carrying the `CF-Access-Client-Id` /
`CF-Access-Client-Secret` pair, per attached target, not a browser-context option. It is deliberately
NOT built yet: an arming path nobody can exercise is an untested code path in the one instrument the
campaign depends on, and the crossing can only be proved once the Access application and its service
token exist.
