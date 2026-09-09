# Authentik (OIDC provider)

**Stack**: Authentik (Docker Compose, project name `miconnect`)  
**Source**: `infrastructure/authentik/compose.yml`

Canari uses Authentik as its OpenID Connect identity provider. Authentik is deployed as a separate Docker Compose stack alongside the main application stack.

## The box, and the log that settles an OIDC question

Authentik does NOT run on `canari`. It is its own host, reached as **`ssh miconnect`** (via
ProxyJump through `canari`, so PowerShell and not Bash - see
[databases](databases.md#reaching-it-from-a-workstation)). Its containers are `miconnect-server-1`,
`miconnect-worker-1` and `miconnect-postgresql-1`.

**`docker logs miconnect-server-1` is an ACCESS LOG**, and it is the instrument for any question
about a login that failed on a client you cannot attach a debugger to. Every
`/application/o/authorize/` appears with its status, its `redirect_uri` and the client's
`user_agent` - which is what proved the iPad defect
([mobile](../frontend/mobile.md#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish)):
one `status 400` carrying `tauri://localhost/auth/callback` from a user agent calling itself
`Macintosh`. Read it before theorising about a client-side branch.

## Deployment

The CD pipeline ([`cicd.md`](../cicd.md), job `deploy-to-server`):

1. Creates `/home/canari/miconnect/{data,certs,custom-templates}` if absent
2. Copies `infrastructure/authentik/compose.yml` to `/home/canari/miconnect/compose.yml` (versioned source of truth)
3. Generates `/home/canari/miconnect/.env` from GitHub Secrets
4. Runs `docker compose up -d` from the miconnect directory

`up -d` is idempotent: without config changes, Authentik is not recreated.

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

The following must be configured in the Authentik admin UI (not automated via CD):

- **Application**: Canari (OIDC provider, authorization code flow with PKCE)
- **Scopes**: `openid`, `profile`, `email`
- **Redirect URIs**: `https://<domain>/auth/callback`
- **Users**: managed in Authentik; synced to Canari's `users` table on first login

### The three Canari providers, and what each one lets a client come back to

Read this table before touching a redirect URI anywhere: the defect below was a single row of it
being different from the other two, and nothing outside Authentik's own database could see that.

| Provider | `client_id` | Which client uses it | Authorized redirect URIs (all STRICT) |
|---|---|---|---|
| `Canari` (pk 1) | `KyTy6F1C...` | production - web and both stores' STABLE builds | `https://canari-emse.fr/auth/callback`, `https://tauri.localhost/auth/callback`, `http://tauri.localhost/auth/callback`, `http://localhost:1420/auth/callback`, `http://localhost:1421/auth/callback`, `fr.emse.canari://callback` |
| `Canari Dev` (pk 10) | `6cNHJotT...` | `dev.canari-emse.fr` - and every PRE-RELEASE build, TestFlight and the Play tester tracks | `https://dev.canari-emse.fr/auth/callback`, `https://tauri.localhost/auth/callback`, `http://tauri.localhost/auth/callback`, `http://localhost:1420/auth/callback`, `http://localhost:1421/auth/callback`, `fr.emse.canari://callback` |
| `Canari Local` (pk 11) | `qqzuUBQp...` | the LOCAL estate on a workstation, and the harness APK | `http://localhost:1420/auth/callback`, `http://127.0.0.1:1420/auth/callback`, `http://localhost:1421/auth/callback`, `http://localhost:8081/auth/callback`, `fr.emse.canari://callback` |

**The three differ in exactly one dimension - the web origin - and must not differ in any other.**
`fr.emse.canari://callback` is on all three because the SAME packaged app talks to all three: a
build selects its estate with `VITE_AUTHENTIK_CLIENT_ID` and an API URL, never with an identifier.

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

**That pin is load-bearing since the section below**, and it is one query:

```sql
select p.name from authentik_core_provider p where p.authentication_flow_id is null;
-- must return zero rows
```

An unpinned provider falls through `PolicyAccessView.handle_no_permission` to
`ToDefaultFlow.get_flow` (`authentik/policies/views.py:101`), which returns **the BRAND's**
authentication flow first - and the brand's flow is now the failure page, not a login page.

## A share of CAS returns carry no code, and our login page turned that into a livelock - 2026-09-08

**THE FIRST FIGURE PUBLISHED HERE WAS WRONG AND HAD ALREADY BEEN SENT TO THE DSI.** It said "71 of
337, 21%", counting **every** empty return over a denominator that was roughly the BROWSER returns -
and the numerator was full of robots: `curl/8.21.0` (this session's own reproduction probes),
`Apache-HttpClient/5.5.1`, and an `X11; Linux x86_64` Chrome failing 71% of the time, none of them a
student. **Diagnostic traffic enters the population it is measuring**, and a bare callback is the
one request a probe makes constantly and a person almost never does.

**The measurement, re-taken 2026-09-09 over 120 h, browsers only** (`iPhone|iPad|CPU OS|Android|
Macintosh|Windows` in the user agent - everything else is dropped):

| Platform | returns | empty | rate |
|---|---|---|---|
| macOS | 23 | 0 | 0% |
| Windows | 59 | 4 | 7% |
| Android | 122 | 20 | 16% |
| iOS | 198 | 28 | 14% |
| **all browsers** | **402** | **52** | **12.9%** |
| (robots, excluded) | 98 | 74 | - |

So **~10 failed logins a day, ~73 a week**, mobile at roughly three times the desktop rate, and
never once on macOS. Per day the browser rate runs 4% to 22%. An empty return carries **no `code`,
no `state`, no `error`**, which RFC 6749 4.1.2.1 forbids.

**And the failures are TWO populations, which one number hides.** Of the browser IPs that saw an
empty return, **31 also logged in successfully** in the same window - transient, a retry gets them
in - while **7 never succeeded once** (11 empties between them). The first population is a race; the
second is a person who cannot get in at all, which is what `robin.berthod` is. A rate alone would
have merged them.

Authentik always sends `state` (its own `redirect args` lines carry it, and
`sources/oauth/clients/oauth2.py` shows the check reading it back out of the session), CAS preserves
it on the first hop, and every successful return carries `code` and `state`. So the parameter is
lost at `cas.emse.fr/cas/oauth2.0/callbackAuthorize`, where pac4j looks up its
`DISSESSIONOauthOidcServerSupport` cookie. **Nothing on this side can make CAS send a `code`** - what
the DSI has to be told is at the end of this section.

### The chain that turned one failed login into a livelock

```
CAS returns with no code  ->  OAuthCallback.dispatch: token is None
  ->  handle_login_failure()  ->  redirect(settings.LOGIN_URL)
  ->  LOGIN_URL is the literal "authentik_flows:default-authentication" (root/settings.py:34)
  ->  ToDefaultFlow.get_flow() returns brand.flow_authentication FIRST (flows/views/executor.py:524)
  ->  that was miconnect-auth, the app's own login flow
  ->  whose identification stage auto-redirects into CAS  ->  back to line 1, every ~5 s
```

The last step is **client-side**, in the shipped bundle (`web/dist/chunks/FQAXXECP.js`), and fires
on exactly one condition:

```js
let n = i.length === 1, s = (e || []).length === 0;
n && s && !r && this.host.dispatchEvent(new he(i[0].challenge))
// 1 source AND 0 user_fields AND no passwordless_url  ->  enter that source immediately
```

**The error message was never missing.** It is injected server-side into the flow page as
`<script data-id="authentik-messages">[{"level":"error","message":"Authentication failed: State
check failed."}]</script>` and rendered by `<ak-message-container>` as a red toast. But **a page
that auto-redirects cannot show anyone an error** - it left before the toast could be read, which is
why the user saw a silent five-second loop and not a failure. The account (`robin.berthod`,
2026-09-08) never reached Canari once: zero `/auth/callback` in production's nginx log.

### What holds it apart now, and the three ways it comes back

| Flow | Reached by | Contains | Behaviour |
|---|---|---|---|
| `miconnect-auth` | every provider, pinned | `miconnect-identification` (1 source), `miconnect-login` | auto-redirects into CAS - one tap, unchanged |
| `miconnect-auth-fallback` | `brand.flow_authentication` - so a source failure, and any direct visit to the domain | `miconnect-auth-failed` (Deny stage) | renders and STOPS |

A failure now lands on a branded French page: `La requête a été refusée.` plus *"La connexion n'a
pas abouti. Ce n'est pas ton compte : le service d'authentification de l'école (CAS) est revenu sans
réponse valide. Retourne dans l'application et relance la connexion, elle aboutit généralement à la
deuxième tentative."*, with the technical toast underneath. Sending the user back through the app is
the better retry anyway: a fresh authorization gets a fresh session state, where a retry from the
dead flow plan meets the same broken session.

**Three ways this regresses silently:**

- **A provider that stops pinning `authentication_flow`** lands its own logins on that Deny page.
  The query above is the check.
- **Anything that gives the fallback flow an identification stage with one source** re-creates the
  exact condition above. That is how this was first built, on 2026-09-08, with `alumni` as a second
  source to break the condition - **wrong, because the Alumni provider is not wired up yet**
  (user, same day), so it offered a button that leads nowhere. The passwordless link is not an
  option either: its label is the hardcoded string `Use a security key`
  (`renderPasswordlessUrl`), which a password or CAS login would make a lie.
- **NEVER add a `user_field` to `miconnect-auth`.** It is `identification -> user_login` with no
  password stage: the only thing keeping it safe is that nobody can identify anyone, and a username
  box would let anyone log in as anyone. It reads like the one-line fix for the auto-redirect. It is
  an authentication bypass.

The `Alumni Only` identification stage (uuid `19b10365`) is bound to **no flow at all**, which is
deliberate until that provider is connected.

**And one thing waiting for the day it is.** The `Validate promo year` expression policy reads
`context['prompt_data']['attributes']['promo']` and returns
`promo <= datetime.now().year and promo >= 1816` with no check that the value is there. In Python
`None <= 2026` raises `TypeError`, and authentik turns a policy exception into a REFUSAL
(`default-match-policy-exception`), so a prompt that omits the field - or sends it as a string -
refuses the enrolment with a message naming nothing. Every execution in the 30 days to 2026-09-08
passed, because nothing reaches it yet.

**`is-student` refuses nobody, and reading it as an enrolment gate was wrong.** It is bound to a
**flow-STAGE** binding (`#20`), so `passing: false` SKIPS that stage rather than rejecting the
person: 7 `false` results in 30 days, and the two accounts that looked refused on 2026-09-06 -
`jean-hugues.chen` and `maxime.leost` - are both active, both linked to `cas-emse`, and both have
logged in since (2026-09-08 and 2026-09-07). **A policy result is only a refusal if what it is bound
to is the FLOW**; on a stage binding it is a router.

**Owed to the restore path, like the providers above.** The flow, the Deny stage and the brand's
`flow_authentication` live only in Authentik's Postgres: a restore from a backup predating
**2026-09-08** brings the brand back pointing at `miconnect-auth` and the loop with it, with no
symptom until CAS next drops a `code`.

### Reproducing the whole failure on demand - no phone, no CAS account, no waiting for a real one

A callback with no query string is byte-for-byte what CAS sends, so the chain is testable from a
workstation in two seconds. This is the before/after that proved the fix:

```powershell
$curl = "C:\Windows\System32\curl.exe"   # PATH here lacks System32 - call it absolutely
& $curl -sS -L -D - -o NUL -b $jar -c $jar "https://auth.canari-emse.fr/source/oauth/callback/cas-emse/"
# before: 302 /flows/-/default/authentication/ -> 302 /if/flow/miconnect-auth/         (the loop)
# after : 302 /flows/-/default/authentication/ -> 302 /if/flow/miconnect-auth-fallback/ (stops)
```

And the auto-redirect is a **measurement**, never a reading of the admin UI: the flow executor hands
over the three fields that decide it.

```powershell
& $curl -sS -b $jar -c $jar -H "Accept: application/json" `
  "https://auth.canari-emse.fr/api/v3/flows/executor/<slug>/?query="
# component / user_fields / sources / passwordless_url  ->  apply the condition above
# miconnect-auth          -> ak-stage-identification, 1 source, 0 fields  = auto-redirect (correct)
# miconnect-auth-fallback -> ak-stage-access-denied                        = terminal
```

**A stale flow plan survives in a browser session and outlives the stage it names.** Deleting a
stage that a live session has already planned makes the executor raise
`DoesNotExist: IdentificationStage matching query does not exist.` and the user gets the generic
*"Une erreur s'est produite"* card with a request ID - which is what a mid-change reload looked
like here, and is NOT a fault in the new flow. Test a flow change in a FRESH browser context, or the
first thing measured is the transition.

### Three levers for a login page that moves too fast to watch

- **`?inspector`** on any `/if/flow/<slug>/` URL makes `xak-flow-redirect` wait for Enter instead of
  calling `window.location.assign`, which single-steps a loop.
- **`ak create_recovery_key <MINUTES> <username>`** prints a `/recovery/use-token/...` path that logs
  an admin in with no flow at all. **The argument is MINUTES, not days** - `7` gives 7 minutes - so
  regenerate one when needed rather than storing it anywhere.
- **`/if/flow/password-login/`** is a real identification + password + login flow, so it is a way in
  that no CAS or brand change can affect. `/if/flow/miconnect-auth/` is the other.

### The exchange with the DSI, and what their service registration says - 2026-09-09

**A first mail went out on 2026-09-08 quoting "71 of 337, 21%". That figure is wrong** (see the top
of this section) and a correction is owed with the follow-up below. The defect is real and theirs;
the number attached to it was inflated by robots.

The DSI answered with the CAS service registration, `/etc/cas/services/miconnect-oidc-2026030501.json`
on `cas1`, then the full file. **It is NOT reproduced here, deliberately** - it is the DSI's
configuration, this repository is PUBLIC, and it carries their OIDC client secret. What follows is
the reading of it; the file itself stays in the mail thread.

**The access gate was the leading hypothesis for one afternoon, and it is now RULED OUT for the one
person we can name.** `accessStrategy.requiredAttributes` admits only a principal whose SupAnn
resource state for the CAS service is `A`, which made it the obvious candidate for the 7 IPs that
never succeed and for `robin.berthod`, whose last successful login is 2026-06-11, an end-of-year
date. **The DSI confirmed on 2026-09-09 that `robin.berthod` IS authorised.** So a looping,
never-succeeding user passes the gate - the gate is not what stops him. Keep the finding for the
other six, whom nobody has named, and stop leading with it.

**What that leaves is ONE mechanism that explains BOTH populations, and it is the shape of the
failure itself.** A CAS access refusal renders an error page, or at worst returns
`error=access_denied` to the client. **We receive neither: a redirect to our callback with an EMPTY
query string** - the client reached, no parameters at all. That is what a **lost session at
`/cas/oauth2.0/callbackAuthorize`** produces: pac4j cannot reconstruct the authorization request
context, so it sends the browser to the registered `redirectUri` carrying nothing. Two facts make it
fit where the gate does not:

- **A cluster whose session store is not shared fails exactly this way.** `cas1` implies siblings. If
  the authorize request and the callback land on different nodes, the second finds no session. A
  retry that happens to land on the right node succeeds - **the 31**.
- **And if the load balancer pins by source IP, a user whose address hashes to a node that never has
  the session fails EVERY time** - **the 7**, deterministically, with a perfectly valid account. One
  cause, two populations, no coincidence needed. This is now the hypothesis to test first.

**One thing we can test without them, and it costs one gesture.** If the cause is instead a stale or
oversized cookie held by the DEVICE, clearing site data for `cas.emse.fr` fixes it permanently for
that user and changes nothing for anybody else. `robin.berthod` is the case to run it on: **if
clearing fixes him, it is the device; if it does not, it is the node.** That single result splits the
two remaining hypotheses and needs no cooperation from the DSI.

**They check `supannRessourceEtat`, they release `supannRessourceEtatDate`** - different attributes,
and only the second reaches us. So **the state that decides access is invisible on this side**, while
the one we can see is a validity WINDOW (`{SERVICE}[ETAT]:debut:fin`). Authentik holds `promo`,
`formation` and `school_status` and nothing else (`robin.berthod` = `{promo: 2024,
formation: "ICM", school_status: "Eleve"}`). Releasing `supannRessourceEtat` too would let this side
refuse with a sentence that names the reason - and would have settled the gate question in a second
rather than over a mail round trip, which is the argument for asking.

**Three things in the file are wider than the service they describe, and one is a credential.**

- **`supportedGrantTypes` carries `password` and `client_credentials`** where the service only ever
  performs `authorization_code`. Resource-Owner Password Credentials means anybody holding the client
  id and secret can exchange a student's raw password for a MiConnect token, with no browser, no SSO
  and no trace in the flow we watch. `client_credentials` mints a token with no user at all.
- **`supportedResponseTypes` carries `token`, `id_token` and `device_code`** where `responseTypes` is
  `["code"]`. That re-opens the implicit flow, whose tokens land in a URL fragment.
- **The `clientSecret` is a short dictionary word, and it arrived twice identically.** Its value is
  NOT reproduced here and must not be - this repository is PUBLIC. Either the DSI redacted it for the
  mail, or it is the real shared secret, in which case it is the whole protection on the two grants
  above and a rotation is worth asking for. It has been through a chat transcript in either case.

**And the trailing comma is in both pastes, at the same position** - after the `supannRessourceEtat`
entry, before the closing brace. Strict JSON forbids it. `jq . miconnect-oidc-2026030501.json`
settles it in one second, and it matters more than it looks: **a service registry that fails to parse
keeps the last good copy IN MEMORY, per node.** `cas1` implies siblings, so one node holding a
different MiConnect than the others is a node-correlated intermittent failure - the exact shape of a
13% rate that a retry usually escapes.

**Two smaller things.** `generateRefreshToken: true` with no `offline_access` in `scopes`, so a
refresh token is configured and cannot be requested; harmless today because the Authentik source only
performs the initial code exchange. And **the file is truncated at `...`** - whatever follows
(`properties`, an expiration policy, a logout type) has not been seen and could carry another gate.

### The follow-up to send

**Send this as one mail.** It opens with the correction because the wrong figure went out first, and
it closes with the security remarks because they are a courtesy, not the subject.

> Bonjour,
>
> Merci pour la declaration de service complete, elle fait beaucoup avancer le diagnostic. Trois
> points, puis quelques remarques sur le fichier lui-meme.
>
> **1. Correction du chiffre que nous vous avons envoye.** Notre premiere mesure (21%) comptait des
> requetes automatiques dans le numerateur - nos propres sondes de diagnostic, un client Java et un
> navigateur headless. **La mesure corrigee, navigateurs reels uniquement, sur 120 h
> (04-09/09/2026) : 52 retours vides sur 402, soit 12,9%.** Le detail par plateforme : macOS 0/23,
> Windows 4/59 (7%), Android 20/122 (16%), iOS 28/198 (14%). Le defaut est donc reel et nettement
> mobile, mais deux fois moins frequent que ce que nous avions annonce. Desole pour le bruit.
>
> **2. Il y a DEUX populations distinctes, et le point 3 propose une cause unique pour les deux.** Parmi les
> adresses IP qui subissent un retour vide, **31 finissent par se connecter** dans la meme fenetre
> (une nouvelle tentative passe) tandis que **7 n'y arrivent jamais**, certaines apres 3 a 5 essais.
> La premiere ressemble a une course ; la seconde a quelque chose de systematique.
>
> **3. Vous nous confirmez que `robin.berthod` est autorise, et c'est ce qui oriente la suite.**
> Nous pensions a votre `accessStrategy` (`supannRessourceEtat = {service_cas}A`) pour expliquer la
> seconde population. Votre reponse l'ecarte pour le seul compte que nous puissions nommer : il passe
> le controle et n'arrive pourtant jamais a se connecter.
>
> **Ce qui reste explique les DEUX populations d'un coup, et c'est la forme meme de l'echec.** Un
> refus d'acces afficherait une page d'erreur, ou renverrait au minimum `error=access_denied` sur le
> `redirectUri`. **Nous ne recevons ni l'un ni l'autre : une redirection vers notre callback avec une
> query string entierement VIDE** - ni `code`, ni `state`, ni `error`. C'est la signature d'une
> session non retrouvee sur `/cas/oauth2.0/callbackAuthorize` : pac4j ne peut pas reconstituer le
> contexte de la demande d'autorisation et renvoie le navigateur sans rien.
>
> D'ou nos questions, dans cet ordre :
>
> - **Le magasin de sessions est-il partage entre les noeuds du cluster ?** Si la requete
>   `/authorize` et le retour `/callbackAuthorize` peuvent atterrir sur deux noeuds differents, le
>   second ne trouve rien - et une nouvelle tentative qui retombe sur le bon noeud reussit. Cela
>   decrirait exactement nos 31 adresses qui finissent par passer.
> - **Le repartiteur de charge epingle-t-il par adresse IP source ?** Si oui, un utilisateur dont
>   l'adresse tombe toujours sur le meme noeud echouerait **a chaque fois**, avec un compte
>   parfaitement valide - ce qui decrirait nos 7 adresses qui n'y arrivent jamais, `robin.berthod`
>   compris. Une seule cause, deux populations.
> - **Que fait CAS, concretement, quand un principal echoue au controle `requiredAttributes` ?** Page
>   d'erreur ou redirection ? Nous posons la question meme si ce n'est pas le cas de robin : c'est ce
>   qui nous dit si un refus peut se deguiser en retour vide.
>
> De notre cote nous faisons vider les donnees de site `cas.emse.fr` sur le telephone concerne : si
> cela le debloque, la cause est un cookie sur l'appareil et non chez vous, et nous vous le dirons.
>
> **Ce que nous pouvons vous donner pour recoupement**, horodatages precis de retours vides de
> navigateurs mobiles reels (heure serveur, UTC) :
>
> ```
> 2026-09-09T10:26:38  2001:861:3080:b300:e3a6:9fe3:8edb:c6   iOS
> 2026-09-09T10:27:02  2001:861:3080:b300:e3a6:9fe3:8edb:c6   iOS   (nouvelle tentative, echec aussi)
> 2026-09-09T11:32:21  2a01:cb16:2069:74cf:0:54:1dad:f401     Android
> 2026-09-09T14:00:49  144.214.255.138                        Android
> 2026-09-09T15:26:23  93.23.17.178                           Android
> ```
>
> Ce qui nous aiderait le plus : les journaux CAS de `/cas/oauth2.0/callbackAuthorize` sur ces
> instants, en particulier une trace de session non retrouvee ou de refus d'acces au service.
>
> **Deux choses dans le fichier, en passant.**
>
> - **La map `requiredAttributes` se termine par une virgule** avant l'accolade fermante, et elle est
>   presente dans les deux copies que vous nous avez envoyees. Si elle est bien dans le fichier,
>   `jq . miconnect-oidc-2026030501.json` le dira tout de suite. Ce detail nous interesse
>   particulierement : **un service qui ne se recharge pas garde en memoire la derniere version
>   valide, noeud par noeud** - et `cas1` laisse supposer des freres. Un seul noeud divergent
>   produirait exactement des echecs intermittents comme les notres, que l'utilisateur contourne en
>   reessayant.
> - **Vous liberez `supannRessourceEtatDate` mais vous controlez sur `supannRessourceEtat`.** Si vous
>   pouviez liberer aussi ce dernier, nous pourrions afficher a l'etudiant refuse un message qui
>   nomme la raison, au lieu d'un echec generique.
>
> **Et deux remarques de securite, que nous vous signalons par acquit de conscience** - c'est votre
> configuration et vous avez peut-etre de bonnes raisons :
>
> - `supportedGrantTypes` contient `password` et `client_credentials`, alors que MiConnect n'utilise
>   que `authorization_code`. Le grant `password` permet a qui detient le `clientId` et le
>   `clientSecret` d'echanger le mot de passe brut d'un etudiant contre un jeton, sans navigateur et
>   sans SSO. De meme `supportedResponseTypes` contient `token` et `id_token`, donc le flux
>   implicite. Nous n'avons besoin d'aucun des deux : `authorization_code` + `refresh_token` et
>   `code` suffisent.
> - Le `clientSecret` est un mot court et identique dans les deux copies. S'il s'agit d'un caviardage,
>   parfait. Sinon, c'est lui qui protege les deux grants ci-dessus, et nous sommes preneurs d'une
>   rotation - de notre cote elle se fait en une minute.
>
> Enfin, le fichier que vous nous avez transmis est tronque apres l'`accessStrategy` : s'il reste des
> `properties` ou une politique d'expiration en dessous, elles nous interessent aussi.
>
> Merci beaucoup,

## Login page branding

`infrastructure/authentik/custom-login.css` is the versioned source of truth for the login flow's
custom CSS. Authentik has no mechanism to load this from a file or a repo path - it must be pasted
manually into the admin UI (System -> Brands -> the Canari brand -> "Custom CSS") after any edit,
and the field itself lives only in Authentik's Postgres DB, so a change made only there and never
copied back here is one lost/stale backup away from disappearing silently.

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

## Database and backup

The PostgreSQL database (volume `miconnect_database`) contains all Authentik configuration: providers, applications, users, OIDC settings. It is backed up daily by [`infrastructure/backup/backup.sh`](../../../infrastructure/backup/backup.sh) as `authentik_db.sql.gz`.

Restore: `./infrastructure/backup/restore.sh --latest-from-mitv --yes` (restores `authentik_db` alongside Canari data).

**THE USER COUNT IS A LIVE POPULATION AND IS NEVER EVIDENCE OF ANYTHING.** Two readings taken hours
apart on 2026-09-02 gave 465 and then 511, which was chased as a discrepancy after two test accounts
were created; a third gave 517. There is **no LDAP source** (`LDAPSource.objects.all()` is empty) -
real people are enrolling continuously, several in the hour that was measured. So a count is a
snapshot of something moving: compare identities, never totals, and if a total must be quoted, quote
the instant with it. Every account is `type=internal` (`external` and `service_account` are both
zero, with one `internal_service_account`), which is why the campaign's dedicated accounts had to be
`internal` too - see [cross-client-campaign-resume](../cross-client-campaign-resume.md).

## See also

- [`services/core-service.md`](../services/core-service.md) — OIDC callback, JWT issuance, auth verification
- [`architecture.md`](../architecture.md) — Auth flow diagram, per-request auth
- [`infrastructure/nginx.md`](nginx.md) — `auth_request` configuration
- [`infrastructure/backup.md`](backup.md) — Backup and restore procedures
- [`infrastructure/MIGRATION.md`](../../../infrastructure/MIGRATION.md) — Server bootstrap and migration
