# Authentik (OIDC provider)

**Stack**: Authentik (Docker Compose, project name `miconnect`)  
**Source**: `infrastructure/authentik/compose.yml`

Canari uses Authentik as its OpenID Connect identity provider. Authentik is deployed as a separate Docker Compose stack alongside the main application stack.

## The box, and the log that settles an OIDC question

Authentik does NOT run on `canari`. **Since 2026-09-24 it runs on the Portail-etu host**, reached
as **`ssh portail-etu-direct`** ([estate-migration](estate-migration.md)); its containers kept their
names, `miconnect-server-1`, `miconnect-worker-1` and `miconnect-postgresql-1`. `ssh miconnect` still
answers, but that VM now runs only `miconnect-relay` and a `miconnect-postgresql-1` of its own -
measured with `docker ps` on both hosts, 2026-09-25 - so a log or a shell read there is the WRONG
Authentik.

**`docker logs miconnect-server-1` is an ACCESS LOG**, and it is the instrument for any question
about a login that failed on a client you cannot attach a debugger to. Every
`/application/o/authorize/` appears with its status, its `redirect_uri` and the client's
`user_agent` - which is what proved the iPad defect
([mobile](../frontend/mobile.md#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish)):
one `status 400` carrying `tauri://localhost/auth/callback` from a user agent calling itself
`Macintosh`. Read it before theorising about a client-side branch.

## Deployment

**Two halves, deployed differently.** The STACK (`compose.yml`, `.env`) is deployed by hand: it runs
from `/srv/miconnect/` on the Portail-etu host, and a change reaches production only when someone
copies the file there and runs `docker compose up -d`, which recreates the containers whose
configuration changed - sign-in is down while `server` restarts. The history, and the job
`deploy-to-server` this section described until 2026-09-24 (it never existed), are in
[the stack's README](../../../infrastructure/authentik/README.md). **The CONFIGURATION - flows,
stages, prompts, policies, mappings, sources, providers, applications, the brand - is code since
2026-09-30**, and every stable release applies it: [below](#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30).

## The configuration is code: `infrastructure/authentik/blueprints/` (2026-09-30)

Seven authentik blueprints, numbered in dependency order, name every object that was built by hand
(63 of them). `apply-blueprints.sh dry-run|apply|snapshot` applies them from the machine the
container runs on. It sends the blueprints on stdin together with `apply-blueprints.py`, so nothing
is mounted into or copied onto the host.

| Who | Mode | What it proves |
| --- | --- | --- |
| CI, job `test-miconnect-blueprints`, when `infrastructure/authentik/` changes | `apply` twice on a FRESH authentik booted from the real `compose.yml`; then, on a second one, `main`'s blueprints first and these over them (`PREVIOUS_REF`) | every object can be BUILT, every `!Find`/`!Env` resolves, every rename runs, and the second apply reports `0 change(s)` |
| a pre-release (`serve-dev.yml`) | `dry-run` against production | prints exactly what the stable will change, then rolls back. Dev signs in through the production MiConnect, so it must write nothing |
| a stable release (`serve-prod.yml`, before `prod-released` moves) | `apply` | one transaction: a failure leaves MiConnect as it was and fails the job |

**THE CI JOB TIMED OUT AT 25 MINUTES AND FAILED THREE PRs (2026-09-30), and the cause was the WAIT, not
the blueprints.** The script waits for authentik's 31 OWN default blueprints before applying ours,
and that wait was a bare loop bounded by the job timeout: it printed `WAIT 30/31` to the end. authentik's
`apply_blueprint` task marks an instance `error` when its validation or a database call fails and
**never retries it** until the file changes or the worker restarts, so one lost race at boot is a
PERMANENT 30/31, not a slow boot. A fresh boot reaches 31/31 in about 2 minutes, and three local boots did.
`wait-default-blueprints.sh` now ends on a proof: READY; a STALL (the count of applied instances has
not moved for 60 s once it moved at all) re-applies what is not `successful` ONCE through the task
authentik uses, in a `::warning::` that NAMES them; a second stall, or 10 minutes with nothing applied,
FAILS printing the leftovers, their status and the worker's error lines. **The thirty-first has not been
named yet** - the next warning in a CI log will name it, and THAT is the evidence to act on (a retry that
keeps being needed is a race to fix, not a path to keep). The wait is proved against a fake `docker` in
`.github/scripts/tests/wait-default-blueprints.test.sh`.

**THE PROOF THAT THE FILES DESCRIBE PRODUCTION, and how to take it again.** `snapshot` prints every
object the blueprints name, with relations replaced by natural names and secrets by a digest. On
2026-09-30, a fresh instance built from the blueprints and production were compared field by field.
They differed in ONE value: a trailing newline at the end of the `avatar` expression. That newline
was written through the model on 2026-09-30, and no blueprint can write it, because the API
serializer strips trailing whitespace. The first `apply` on production, the same day, reported that
1 change, and the dry run after it reported 0. Re-take the proof after any hand edit:

```sh
AK_REMOTE="ssh portail-etu-direct" bash infrastructure/authentik/apply-blueprints.sh snapshot > prod.json
bash infrastructure/authentik/test-blueprints.sh   # or snapshot a local instance built from the files
```

**An eighth blueprint, `80-profile-editor.yaml` (WP4, 2026-10-04)**, builds the service account Canari
writes profiles through: a role holding `view_user` and `change_user` only, the group that carries it,
the account `miconnect-canari-editor` and its API token, whose key is `!Env MICONNECT_EDITOR_TOKEN`.
CI then USES the token (`test-profile-editor.py`): read by uuid and PATCH work, creating or deleting a
user and changing a flow answer `403`. The applier compares the token's `key` by digest like the other
secrets, and ignores `expires` on a non-expiring token, which authentik rewrites at every apply
([profiles-and-access](../profiles-and-access.md#the-work-packages-in-order)).

**What is NOT in the blueprints, deliberately:**

- **Users and groups**: they are the population, not the configuration.
- **The providers' client secrets**: an entry that does not name a field leaves it untouched, so the
  live secrets never reach this public repository. On a fresh instance they are generated. The
  database backup is what restores them ([below](#database-and-backup)).
- **The signing certificate**: authentik creates it at bootstrap.
- **The default objects**: they are authentik's own blueprints' business, and ours `!Find` them.

**The CAS client secret IS in them**, as `!Env MICONNECT_CAS_CONSUMER_SECRET`, because authentik
refuses to create an OAuth source without one. It lives in `/srv/miconnect/.env`, and `compose.yml`
declares it with `:?`, so a `.env` that lacks it fails the start instead of blanking the secret.

**An edit made in the admin UI is reverted by the next stable release.** Every release re-applies
every entry, so a hand change is either written into the files in a pull request or it is lost.

**A RENAME IS TWO ENTRIES, because an entry FINDS its object by the name it gives it** (WPA-2,
2026-09-30). Changing the identifier alone would build a second object under the new name and leave
the old one where it is. So each file opens with a `RENAMES` block: one entry per object, carrying
`conditions: [!Find <the old name>]`, found by `pk: !Find <the old name>`, and setting only the new
one. **By pk, never by `name: <old>`**: authentik merges an entry's identifiers back into its
attributes (`always_merger.merge` in the importer), so an entry found by its old name writes the old
name straight back - a rename that silently does nothing, caught by the upgrade test. A fresh
instance skips it; production is renamed in place, and every reference follows, because references
are rows and not names. The applier reads such an entry as a rename, so the diff says `CHANGED
.name`, and it REFUSES a commit that leaves an old name standing. The block is dead once production
has taken it, and is deleted then - so the names older pages quote are kept here:

| Kind | Before WPA-2 | Since |
| --- | --- | --- |
| scope mappings | `First + Last Names`, `Formation`, `Personnel de l'école`, `Promotion`, `avatar`, `fake-email` | `miconnect-claim-name`, `-formation`, `-school-status`, `-promo`, `-avatar`, `-email` |
| CAS source mapping | `CAS EMSE` | `miconnect-cas-identity` |
| prompts | `Formation`, `Promotion`, `School Worker` | `miconnect-enrollment-prompt-formation`, `-promo`, `-status` |
| policies | `Validate promo year`, `is-student`, `Merge attributes` | `miconnect-enrollment-validate-promo`, `-is-student`, `-merge-status` |
| prompt stages | `Request School Status`, `Request Promo & Formation` | `miconnect-enrollment-ask-status`, `-ask-promo`, then (WP2, 2026-10-01) `-ask-affiliations`, `-ask-cursus` |
| enrolment flows | `miconnect-enrollment-cas`, `miconnect-enrollment-alumni` | ONE flow, `miconnect-enrollment`, bound to both sources (WP2); the alumni flow and the prompt `-prompt-status` are deleted |
| redirect stage | `Archives MINO logout redirect` | `miconnect-logout-redirect-archives` |
| flow (slug) | `mino-provider-invalidation-flow` | `miconnect-invalidation-mino` |
| providers | `Archives MINO`, `Canari`, ..., `Provider for Sky` | `miconnect-<application slug>` |

**What keeps its old name, deliberately: every name another system HOLDS.** The source slugs
`cas-emse` and `alumni` are in the callback URLs registered at the CAS and the alumni IdP. The
application slugs are in each client's issuer URL, a rename deferred with the OIDC issuer. The slug
`password-login` is the test campaign's `PASSWORD_LOGIN_FLOW_SLUG`. Stage, prompt, policy, mapping and
provider names are read by nothing outside authentik, and those are the ones renamed.

Traps found while writing this, each measured on authentik 2026.8.0:

- **`ak apply_blueprint` exits 0 when a blueprint FAILS to apply**: it ignores the return value of
  `Importer.apply()`. `apply-blueprints.py` checks that value, exits non-zero on failure, and prints
  authentik's log lines.
- **The worker's own discovery applies a file only when its hash changes**, concurrently with anything
  else that applies it. Every file therefore carries `blueprints.goauthentik.io/instantiate: "false"`,
  and the script is the ONE applier. The same fact explains the `Default - Out-of-box-experience`
  instance: it has shown `error` since 2026-08-29, it validates cleanly today, and nothing re-applies
  it until its file changes. Applied inside a rolled-back transaction on 2026-09-30, it changes NO
  object, and `initial-setup` keeps its guard (`default-oobe-password-usable`), so re-applying it
  only resets the status.
- **`!Find`, `!Env` and `!File` resolve to null and carry on** when they match nothing. A mistyped
  name would silently clear a nullable reference, which is why the brand CSS is written inline rather
  than read through `!File`. The applier refuses any `!Find` or `!Env` that resolves to nothing,
  before it commits.
- **A policy bound to a stage binding targets its `pbm_uuid`**, while `!Find` returns `.pk`, the
  child's own key. The target is therefore found on `authentik_policies.policybindingmodel`, through
  `flowstagebinding__...` lookups.
- **The brand is identified by `default: true`, not by its domain**: it IS the `authentik-default`
  brand, renamed, and authentik refuses a second default.
- **`oidc_jwks` is a cache** of the CAS's keys, refreshed from `oidc_jwks_url`, so it is left out.
  Freezing it would rewrite stale keys at every release.

## OIDC flow

Authentik acts as the OIDC **Provider**; Canari's [`core-service`](../services/core-service.md) acts as the **Relying Party**:

```
Browser → Authentik /authorize (PKCE + state)
  → User authenticates (login/password, SSO)
  → Redirect to /auth/callback?code=...&state=...
  → Browser POSTs code to core-service
  → core-service exchanges code for tokens (server-side)
  → core-service upserts user in PostgreSQL (sub = userId)
  → Returns { access_token (JWT HS256, 15 min), refresh (HttpOnly cookie, 7d) }
```

The user's `sub` claim from Authentik becomes the canonical `userId` across all Canari services (`findOrCreateFromOidc` uses `userinfo.sub` as the primary key).

## Nginx auth_request integration

Every protected request goes through `auth_request /internal/auth/verify`:

1. Nginx calls `core-service:3012/api/auth/verify` (internal only, never public)
2. `core-service` validates the JWT from the `Authorization: Bearer` header
3. On success: Nginx injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` headers
4. Upstream services trust these headers (Nginx strips client-supplied ones on all public locations)

## Configuration

### GitHub Secrets

| Secret | Role |
|---|---|
| `AUTHENTIK_CLIENT_ID` | OIDC client ID (Canari application in Authentik) |
| `AUTHENTIK_CLIENT_SECRET` | OIDC client secret |
| `AUTHENTIK_URL` / `AUTHENTIK_ISSUER` | Authentik issuer URL |
| `MICONNECT_PG_PASS` | Authentik PostgreSQL password |
| `MICONNECT_AUTHENTIK_SECRET_KEY` | Authentik secret key |

### Authentik-side setup

Every provider, application, redirect URI and scope mapping is in
`infrastructure/authentik/blueprints/` since 2026-09-30, and a change to one is a pull request
there, never an edit in the admin UI ([above](#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30)).
Users are managed in Authentik and synced to Canari's `users` table at each sign-in.

### The three Canari providers, and what each one lets a client come back to

Read this table before touching a redirect URI anywhere: the defect below was a single row of it
being different from the other two, and nothing outside Authentik's own database could see that.

| Provider | `client_id` | Which client uses it | Authorized redirect URIs (all STRICT) |
|---|---|---|---|
| `Canari` (pk 1) | `KyTy6F1C...` | production - web and both stores' STABLE builds | `https://canari-emse.fr/auth/callback`, `https://canari.emse.fr/auth/callback`, `https://tauri.localhost/auth/callback`, `http://tauri.localhost/auth/callback`, `http://localhost:1420/auth/callback`, `http://localhost:1421/auth/callback`, `fr.emse.canari://callback` |
| `Canari Dev` (pk 10) | `6cNHJotT...` | `dev.canari-emse.fr` - and every PRE-RELEASE build, TestFlight and the Play tester tracks | `https://dev.canari-emse.fr/auth/callback`, `https://tauri.localhost/auth/callback`, `http://tauri.localhost/auth/callback`, `http://localhost:1420/auth/callback`, `http://localhost:1421/auth/callback`, `fr.emse.canari://callback` |
| `Canari Local` (pk 11) | `qqzuUBQp...` | the LOCAL estate on a workstation, and the harness APK | `http://localhost:1420/auth/callback`, `http://127.0.0.1:1420/auth/callback`, `http://localhost:1421/auth/callback`, `http://localhost:8081/auth/callback`, `fr.emse.canari://callback` |

**The three differ in exactly one dimension - the web origin(s) - and must not differ in any
other.** `fr.emse.canari://callback` is on all three because the SAME packaged app talks to all
three: a build selects its estate with `VITE_AUTHENTIK_CLIENT_ID` and an API URL, never with an
identifier. `Canari` (pk 1) carries TWO web origins since 2026-09-25, additively: `canari-emse.fr`
stays until the estate migration's browser-storage rule
([estate-migration](estate-migration.md#a-browser-cannot-follow-a-redirect-and-keep-its-state---and-the-user-took-that-cost-knowingly-2026-09-25))
lets it retire, `canari.emse.fr` was added the same way the vhost was - by hand, via `ak shell`, the
admin UI's `redirect_uris` textarea reads as a single string but the field is actually a list of
`RedirectURI` objects that must be REASSIGNED whole (`p.redirect_uris = [...]`), not mutated in
place - appending to the list `p.redirect_uris` returns and calling `.save()` silently keeps the
old value, because that attribute is rebuilt fresh from the stored JSON on every read.

**That rule covers `grant_types` too, and the two sections below are what happens when it does not.**
On 2026-09-07 `Canari Dev` differed from its siblings in BOTH fields at once, and the first fault
hid the second. When comparing providers, compare every field, not the one the symptom names.

### The one redirect URI a mobile client needs, added by hand on two providers

Both providers carry `fr.emse.canari://callback` as an **authorization** redirect URI with
**strict** matching, alongside their web entry. Both were added by hand, in the admin shell, and
this paragraph is the only record of either:

```sh
ssh miconnect
docker exec -i miconnect-server-1 ak shell    # then set the RedirectURI on the provider, and re-read it
```

`redirect_uris` is a **list of `RedirectURI` objects** (`authentik.providers.oauth2.models`), each
carrying a `matching_mode` and a `url` - not a newline-separated text field, which is what the admin
UI shows and what a first attempt at this will assume.

**Why it was needed.** A packaged mobile client does not come back to a URL, it comes back to its
own custom scheme - `fr.emse.canari://callback`, the deep link declared in
[`tauri.conf.json`](../../../frontend/src-tauri/tauri.conf.json). A phone whose provider does not
list that scheme reaches the IdP, authenticates, and is refused at the last hop with Authentik's own
**"Redirect URI Error"** - a message that names the provider's configuration and not the client,
which is why it reads like an app fault and is worth recognising on sight.

**`Canari Dev` cost a real tester a login, and the shape of the mistake is worth keeping.** Until
2026-09-07 it listed `fr.emse.canari.dev://callback` instead: a scheme NOTHING in this repository
declares. `tauri.conf.json` has identifier `fr.emse.canari` and the deep-link plugin registers that
one scheme only, so the dev provider was waiting for a callback no build could ever send. A
TestFlight tester on the pre-release build 1600401 was refused three times on 2026-09-06 - visible
in `docker logs miconnect-server-1` as `400` on `/application/o/authorize/` with
`client_id=6cNHJ...` and `redirect_uri=fr.emse.canari://callback`. The dead `.dev` entry was
DELETED in the same gesture that added the real one: left in place it tells the next reader that a
`.dev` scheme exists.

**And the fix belonged here, not in the app.** Making the dev build answer to `.dev://` would need a
separate bundle identifier (`fr.emse.canari.dev`), hence its own provisioning profile, its own App
Store record and its own scheme declaration. That is not the shape of this ecosystem, where the dev
and prod builds share the identifier and differ only by `client_id` and API URL. Sharing the
identifier also means the two apps cannot coexist on one phone, so reusing the scheme creates no OS
routing ambiguity.

**SUPERSEDED IN INTENT 2026-09-15**: the user decided a second package id `fr.emse.canari.dev` beside `fr.emse.canari` ([backlog](../backlog.md), [mobile](../frontend/mobile.md)); the shared-identifier statement above is the CURRENT state, not the target. When that lands, `fr.emse.canari.dev://callback` must be re-added on `Canari Dev` (the entry deleted on 2026-09-07 was dead only because no build declared it).

**Why none of this weakens the separation `infrastructure/.env` exists to enforce.** The danger that
split is aimed at is a page served from one estate obtaining tokens for another. Every provider here
is **confidential**: an authorization code handed to the custom scheme is worthless without the
client secret, which only that estate's backend holds. So the addition widens what may RECEIVE a
code on one client, never what may exchange one, and it grants nothing on any other client.

**It is a hand mutation on a production box, so it is owed to the restore path.** It lives in
Authentik's Postgres and nowhere else, exactly like the login CSS below: a restore from a backup
taken before **2026-09-04** (`Canari Local`) or **2026-09-07** (`Canari Dev`) brings it back
missing, and the symptom is the "Redirect URI Error" above rather than anything that names a
redirect URI. Re-add it on BOTH providers after any restore that predates those dates.

**What guards the app half, and what guards nothing.**
[`frontend/src/lib/mobile/oidcRedirectScheme.test.ts`](../../../frontend/src/lib/mobile/oidcRedirectScheme.test.ts)
asserts that the scheme `oidcRedirectUri()` builds is one `tauri.conf.json` actually declares. It
would have failed the day somebody wrote `fr.emse.canari.dev` expecting the app to follow. It
cannot see Authentik's database, which does not live in this repository - this page is the only
thing that protects that half.


### `Canari Dev` permitted NO grant type, so dev login was refused for everybody - fixed 2026-09-07

**Measured, not suspected.** `OAuth2Provider.objects.get(pk=10).grant_types` was `[]`. `Canari`
(pk 1) and `Canari Local` (pk 11) both carry the full list authentik creates a provider with:

```
['authorization_code', 'hybrid', 'implicit', 'client_credentials', 'password',
 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
```

`check_grant` in `authentik/providers/oauth2/views/authorize.py` raises
`AuthorizeError(error="invalid_request")` when `self.grant_type not in self.provider.grant_types`,
and an empty list matches nothing. So EVERY authorization against `Canari Dev` is refused, on every
redirect URI - **the web one included**:

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' \
  "https://auth.canari-emse.fr/application/o/authorize/?client_id=6cNHJ...&redirect_uri=https%3A%2F%2Fdev.canari-emse.fr%2Fauth%2Fcallback&response_type=code&scope=openid+profile&state=probe"
# 302 https://dev.canari-emse.fr/auth/callback?error=invalid_request&error_description=The%20request%20is%20otherwise%20malformed
```

**It was hidden behind the redirect URI defect above.** A request that fails
`check_redirect_uri` never reaches `check_grant`, so while the mobile URI was missing, this second
fault could not be seen from a phone - and fixing only the first moves a tester from "Redirect URI
Error" to "invalid_request" with no login either way. Two faults on one provider, stacked, and the
outer one masked the inner one: that is why the fix was verified by PROBE rather than by re-reading
the field that had just been written.

**A custom scheme also changes what an error LOOKS like, which is worth knowing before diagnosing
one.** Authentik reports an `AuthorizeError` by redirecting it to the client's `redirect_uri`, and
Django's `HttpResponseRedirect` allows `http`, `https` and `ftp` only. So on `fr.emse.canari://`
the redirect raises `DisallowedRedirect` and the client sees a bare **400** with no `error=`
parameter at all, while the same fault on the web URI arrives as a readable
`302 ...?error=invalid_request`. **To read the real error behind a mobile 400, replay the request
against the provider's https redirect URI.** The line to look for on the box is
`django.security.DisallowedRedirect` - "Unsafe redirect to URL with protocol 'fr.emse.canari'".

**The remedy** was to give pk 10 the same list as its two siblings, copied from pk 1 rather than
retyped, with an assertion that pk 1 and pk 11 agreed before copying either. It is a hand mutation
on a production box and is owed to the restore path exactly like the URIs above: **a restore from a
backup predating 2026-09-07 brings `Canari Dev` back with an empty `grant_types` and no dev login at
all, web or mobile.**

**What proves it, and what does not.** Re-reading the field after writing it proves only that the
write landed - it says nothing about the second fault waiting behind the first. The check that
settles it is the probe, on BOTH redirect URIs, and the answer to look for is a **302 to
`/if/flow/miconnect-auth/`** rather than any 2xx or 4xx:

```sh
CID=<the Canari Dev client_id>
for uri in "https://dev.canari-emse.fr/auth/callback" "fr.emse.canari://callback"; do
  enc=$(python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$uri")
  curl -s -o /dev/null -w "$uri -> %{http_code} %{redirect_url}\n" \
    "https://auth.canari-emse.fr/application/o/authorize/?client_id=$CID&redirect_uri=$enc&response_type=code&scope=openid+profile&state=probe"
done
```

Run it against any provider on this box after touching it. It needs no account, no secret and no
device, and it distinguishes all three failure shapes: a `400` with `DisallowedRedirect` in the log
(mobile scheme, some other fault), a `302 ...?error=<code>` (the fault, readable) and a `302
/if/flow/...` (the provider is willing, and what is left is the user's own credentials).

### And a THIRD field on pk 10 differed - it had no `authentication_flow`, fixed 2026-09-08

The rule above ("compare every field, not the one the symptom names") held a third time.
`Canari Dev` was the only one of the seven providers on this box with
`authentication_flow_id IS NULL`, so a dev login did not enter `miconnect-auth` and met a
username/password form instead of CAS - which is what the `login_failed` events against that
provider are. All seven now pin it explicitly, copied from pk 1.

**That pin is worth asserting**, and it is one query:

```sql
select p.name from authentik_core_provider p where p.authentication_flow_id is null;
-- must return zero rows
```

An unpinned provider falls through `PolicyAccessView.handle_no_permission` to
`ToDefaultFlow.get_flow` (`authentik/policies/views.py:101`), which returns **the BRAND's**
authentication flow rather than the provider's - so it silently authenticates against whatever the
brand happens to point at.

## Login page branding

**The login CSS is `branding_custom_css` in `infrastructure/authentik/blueprints/70-brand.yaml`, the
ONLY copy since 2026-09-30.** It was `infrastructure/authentik/custom-login.css`, pasted into the
Brand by hand or through `ak shell`. That file was deleted the day the brand became a blueprint: it
was byte-identical to the live field (13164 characters), and the next stable release applies any
edit. The paragraphs below keep the procedures that are still true (preview over CDP) and the
history of each rule.

Two failure modes worth knowing before touching it again: a `z-index: -1` decorative element needs
its parent to actually establish a stacking context (`isolation: isolate`, not just
`position: relative`) or it paints behind the whole page instead of just behind its own sibling;
and an external `@import` (e.g. Google Fonts) can silently no-op under Authentik's default CSP,
which blocks it - self-hosting is the fix if an exact custom font is needed.

**Red triangles flashing between stages were an unstyled icon, not a validation error** - settled
by decoding a Firefox profiler capture's screenshot markers (not just reading its metadata: a
truncated export holds none of this and looks identical to a healthy one). Navigating from one
flow to the next (`default-invalidation-flow` -> `miconnect-auth`) reloads the document while the
flow's JS chunks are still loading; for one frame, up to four `pf-c-alert__icon >
i.fas.fa-exclamation-triangle` (Authentik's danger alert icon) rendered at their unstyled intrinsic
size - each roughly a third of the card's height - before the stylesheet that normally constrains
icon size had applied. The CSS now bounds that icon unconditionally rather than racing the load
that used to size it, so the race is removed rather than hidden: a genuine, persisting alert still
renders, at its correct size.

**A page-level rule reused on an inner element stretches the element, not the page** - the
`redirect_uri` error page reported 2026-09-25 as "not centered, huge empty space" had
`min-height: 100vh` plus flex-centering applied to `.pf-c-login` (correct: it is the page wrapper)
AND to `ak-flow-card`/`.pf-c-form__group` (wrong: they are the card's own content, so the SAME rule
stretched the card itself to full viewport height, leaving its short content pinned near the top
with empty space below it). Fixed by keeping the sizing/centering on `.pf-c-login` alone and giving
the inner elements only the dark background they needed. Same date, a first-connection
(enrollment/user-write) stage reported black text on this dark background: the light text-color
rule was gated on `input[type='text'|'password'|'email']`, so a field with no `type` attribute or a
`type` this list didn't name never got it even though it did inherit the dark background from
`.pf-c-form-control`. Fixed by matching `input`/`textarea`/`select` by tag rather than by `type`,
the same "stop scoping, cover the whole flow" fix already applied to the submit button above.

**`.pf-c-login` is a GRID in this Authentik, and overriding its display is what clips the card on a
phone** (measured on the Mi 9T, 2026-09-25). The `display: flex` above turned `ak-locale-select`,
the header, the card and the footer into ONE ROW; on the error page that row outgrew a 393 px
viewport and `overflow: hidden` cut the card's left edge. Removed by #1098 and LIVE since
2026-09-25 - the error page was re-measured signed in on the Mi 9T: grid, header, card and footer
stacked. The #1081 fixes this page called unpasted were already live: the live CSS read back that day
differed from the file by the #1098 lines only.

**Applying a CSS change is a release**, since 2026-09-30: edit `70-brand.yaml`; the pre-release
dry-run prints the change, and the stable release applies it. Then check a flow page on a phone
before calling it done. Until that day it was done through `ak shell` in `miconnect-server-1`. **A
layout change is previewed BEFORE it is applied**: swap the
page's brand stylesheet in a real browser over CDP (`adoptedStyleSheets` / the `<style>` holding
`--rootz-cyan` or `--mc-surface`, `replaceSync` with the new file) - nothing on the server moves,
and the flat redesign of that day was iterated that way on the Mi 9T.

**The flat pass (2026-09-25).** The card is one solid tonal fill (`--mc-surface`) with a hairline
border, no blur, no gradient, no shadow; every `.pf-c-button.pf-m-primary` - `a` included, which is
why "Retourner a l'accueil" had kept PatternFly's blue - is a flat accent fill; on a phone
(`<= 600px`) the card frame goes, Google-style, and the content sits on the page with a 24 px gutter
(the framed card had 17 px of margin). Two defects found on the way: the logo is `img.branding-logo`,
which the old `.pf-c-brand` rule never centred (10 px left, 105 px right), and the header is a FIXED
120 px with 64 px of top padding, so a taller logo spills onto the title. Effects on the error page
after the pass: 0 glow, 0 blur, 0 gradient on components; the background blobs stay (identity). A rule that changes a PatternFly wrapper's `display` has to be checked
against every flow LAYOUT that reuses the wrapper, not just the login stage it was written for.
The flat file on `main` (#1102) is LIVE since 2026-09-25 evening, applied through `ak shell`; the
signed-out fallback flow on the Mi 9T reads 0 glow, 0 blur, 0 gradient, frameless and centred.

## Signing in to MiConnect lands on Canari, and admins keep the admin UI (2026-09-25)

The user asked that signing in to Authentik itself go to Canari by default. The brand's
`default_application` was ALREADY Canari and did nothing: authentik only redirects a user whose
`type` is external or a service account (`authentik/core/views/interface.py`, both
`BrandDefaultRedirectView` for `/` and the user interface's `redirect_to_app`), and every MiConnect
account was `internal` - `miconnect-enrollment-write` created them so. Changed that day, with the
user's go-ahead:

- the 594 accounts that are internal AND in no superuser group are `external`; the 5 admins stay
  `internal`, so `https://auth.canari-emse.fr/if/admin/` still opens for them, unredirected - that
  is the bypass;
- `miconnect-enrollment-write.user_type` is `external`, so a new sign-up lands on Canari too;
- the Canari application's `meta_launch_url` is `https://canari.emse.fr` (it named the old apex).

An external account cannot open authentik's user interface at all (profile, sessions): it is sent
to the default application every time. **Rollback**: set those accounts back to `internal` - the
list of primary keys was printed by the script and kept out of this public repo - and the
enrollment stage back to `internal`. Anything that grants admin must go through a superuser GROUP,
since the predicate that kept the 5 internal was group membership.

## One language: French, in the ecosystem's "tu" (2026-09-25)

Flow titles and prompt labels are rows in authentik's DB, not locale strings, so the French locale
never translated them. Fourteen flow titles and eight prompts were set that day through `ak shell`
(every replaced value printed first, for rollback): "Connexion à MiConnect", "Redirection vers
%(app)s", "Tu es déconnecté de %(app)s.", "Bienvenue sur MiConnect ! Choisis un nom d'utilisateur.",
"Modifier tes informations", "Mot de passe", "Nom d'utilisateur", "E-mail", "Langue"... and the
promotion prompt's "(où année ..." became "ou". **The register is "tu"**, like Sky, Le Cercle and the
custom error text of this very flow - a first pass in "vous" was corrected the same evening.

`miconnect-auth.denied_action` is `continue` (was `message_continue`): opening the flow while
already signed in no longer stops on "Le flux ne s'applique pas à l'utilisateur actuel". Not yet
observed signed in on a phone.

Deliberately left:

- **"Elève" keeps its missing accent as a VALUE, and the label can be fixed alone (read
  2026-09-27).** The `is-student` expression policy compares `custom_statut == "Elève"`, and
  `Merge attributes` copies it into `school_status`, which the applications receive, so the value
  must not change. But authentik 2026.8 takes a choice as `{"label": ..., "value": ...}` as well as
  a bare string (`stages/prompt/models.py`, where the choices are built). So the prompt `School Worker`
  (`custom_statut`, stage `Request School Status`, flow `miconnect-enrollment-cas`) can show
  "Élève" and still submit "Elève". Its placeholder expression is today
  `return ["Elève", "Personnel de l'école"]`, and the change is
  `return [{"label": "Élève", "value": "Elève"}, "Personnel de l'école"]`. **Written
  2026-09-27 with the user's go-ahead**, guarded on the old expression, and `get_choices()` read
  back returns the label/value pair. Nobody has watched an enrolment render it yet. **Retired by WP2
  (2026-10-01): the prompt is gone, replaced by the checkbox page; `"Elève"` is now only a VALUE
  that `miconnect-enrollment-merge-status` writes into `school_status`, for the legacy claim.**
- **"Go back"** on the access-denied stage is authentik's own UI string, untranslated in its French
  bundle (2026.8); nothing in this DB carries it.
- **The static prompt `Alumni Force Link Continue` renders NOWHERE (read 2026-09-27).** Its only
  stage, `Force Link Alumni Notice`, is bound to no flow. A static prompt draws its
  `initial_value` ("Veuillez lier votre compte Mines Saint-Etienne Alumni...", in "vous") and never
  its label, so "ni ça" would not show even if the stage were bound. Whoever binds that stage
  rewrites the text in "tu" first.
- `initial-setup` keeps "Welcome to authentik!" - only the first admin ever sees it.

## The hand-built configuration, audited 2026-09-29

The whole configuration was built by hand in the admin UI, and nothing but the 31 DEFAULT
blueprints describes any of it. Read in full with `ak shell` on 2026-09-29 (cross-references,
orphans, logs); the user asked for it to be made clean and homogeneous.

**Applied that day, in ONE transaction, every object re-proven unreferenced before its deletion and
printed in full (the rollback):**

- Deleted, all bound to nothing: the stages `Alumni Only`, `Force Link Alumni Notice`,
  `miconnect-demande-promo-et-formation` (an older copy of `Request Promo & Formation`, sharing its
  prompts) and `Force Link Alumni`; the prompt `Alumni Force Link Continue`; the policy
  `Need Alumni Source`; the empty flow `miconnect-enroll-aluni-from-cas`. The alumni sketch they
  formed is recorded where it will be rebuilt ([profiles-and-access WP8](../profiles-and-access.md#4-the-technical-plan---validated-by-the-user-2026-09-29)),
  including the one useful fact in it: the link was a redirect to
  `/source/saml/login/alumni/` while signed in.
- **Logging out of ANY of the nine applications ended on the Archives.** A redirect stage `Archives
  MINO logout redirect` had been bound to `default-provider-invalidation-flow`, the invalidation
  flow all nine providers share. It now lives in `mino-provider-invalidation-flow`, set on
  `Archives MINO` and `MinoWiki` only; the default flow is stageless again, as its blueprint ships
  it. No application calls `end-session` today except, presumably, those two, so the reach of the
  defect was the MINO pair's siblings.

**Found and left, each with its reason:**

- `password-login` is reachable by URL only and is NOT dead: the test campaign signs in through it
  (`PASSWORD_LOGIN_FLOW_SLUG`, [cross-client-campaign-resume](../cross-client-campaign-resume.md)).
  It is not an opening for the rest: 586 accounts have an EMPTY password, which matches nothing;
  6 have a real one.
- `miconnect-auth-fallback` is referenced by nothing inside authentik; its deny text describes the
  CAS failure below.
- The `Default - Out-of-box-experience flow` blueprint reports `error` since 2026-08-29. Harmless
  for sign-in, and it is noise. **Not a hand edit, as first read (refuted 2026-09-30)**: a FRESH
  2026.8.0 instance booted with nothing of ours showed the same `error`, its worker having logged
  "Applying blueprint due to changed file" for it twice, 1.3 s apart - two concurrent applies of one
  file. Other fresh boots reached 31 of 31 `successful`, so it is a race at boot.
- **`AUTHENTIK_LOG_LEVEL` was `debug`** in `compose.yml`: 63 % of the lines, and user e-mail addresses
  written into the log. The file now says `info` (the access log, `authentik.asgi`, is emitted at
  info). **Applied the same day**: the file copied to `/srv/miconnect/` (the previous one kept as
`compose.yml.bak-2026-09-29`), `docker compose up -d`, both containers read back `info`, the
`/authorize` probe answered `302` to `miconnect-auth` and no warning or error followed.
- **About 1 CAS return in 6 fails (measured 2026-09-29, OPEN, a request is with the DSI)**: `docker
  logs miconnect-server-1` since its 2026-09-24 restart held **72 `State check failed`**
  (`authentik.sources.oauth.views.callback`, preceded by "No state parameter returned by the
  source") against ~420 responses on `/source/oauth/callback/cas-emse/`, between 3 and 21 a day. Every
  failing request reads the BARE callback URL (no `code`, no `state`, no query string), while a
  working one carries `?code=...&state=...`: not a stale or mismatched state, the CAS sends the
  browser to the callback without answering the authorization request. The same user agent fails
  three times in a row (a Linux desktop and an Android phone on 2026-09-29), so people retry and stay
  out. The deny text of the unreferenced `miconnect-auth-fallback` flow describes exactly this, so
  somebody met it before and it was never measured. Open: [backlog](../backlog.md#p2---about-one-cas-return-in-six-reaches-miconnect-with-no-code-and-no-state-and-the-sign-in-fails-measured-2026-09-29).
- The CAS source sends no PKCE although the CAS advertises `S256`; application launch URLs still name
  `mitv.fr` and `canari-emse.fr` hosts; names mix French and English (`Personnel de l'école`,
  `School Worker`, `Provider for Sky`); the Cercle's tokens live 30 s / 2 min where every other
  provider has 5 min / 30 days. **All settled by WPA-2 (2026-09-30)**, the Cercle's lifetimes KEPT by
  the user ([profiles-and-access](../profiles-and-access.md#4-the-technical-plan---validated-by-the-user-2026-09-29)).

## Database and backup

The PostgreSQL database (volume `miconnect_database`) contains all Authentik configuration: providers, applications, users, OIDC settings. It is backed up daily by [`infrastructure/backup/backup.sh`](../../../infrastructure/backup/backup.sh) as `authentik_db.sql.gz`.

Restore: `./infrastructure/backup/restore.sh --latest-from-mitv --yes` (restores `authentik_db` alongside Canari data).

**THE USER COUNT IS A LIVE POPULATION AND IS NEVER EVIDENCE OF ANYTHING.** Two readings taken hours
apart on 2026-09-02 gave 465 and then 511, which was chased as a discrepancy after two test accounts
were created; a third gave 517. There is **no LDAP source** (`LDAPSource.objects.all()` is empty) -
real people are enrolling continuously, several in the hour that was measured. So a count is a
snapshot of something moving: compare identities, never totals, and if a total must be quoted, quote
the instant with it. Every account was `type=internal` until 2026-09-25, when all but the admins
became `external` ([above](#signing-in-to-miconnect-lands-on-canari-and-admins-keep-the-admin-ui-2026-09-25));
read 2026-09-29: 600 `external`, 5 `internal` (the `authentik Admins` group), 1
`internal_service_account`. What each account declared at enrolment, and what the applications
decide from it, is measured on [profiles-and-access](../profiles-and-access.md#1-what-exists-today-measured-on-production-2026-09-29-1436-utc).

## See also

- [`services/core-service.md`](../services/core-service.md) — OIDC callback, JWT issuance, auth verification
- [`architecture.md`](../architecture.md) — Auth flow diagram, per-request auth
- [`infrastructure/nginx.md`](nginx.md) — `auth_request` configuration
- [`infrastructure/backup.md`](backup.md) — Backup and restore procedures
- [`infrastructure/MIGRATION.md`](../../../infrastructure/MIGRATION.md) — Server bootstrap and migration
