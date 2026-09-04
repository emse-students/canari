# Sessions, in every application

Canari, Sky, MiGallery and Le Cercle all sign users in, and by 2026-08-04 all four run the same
session model. This page is the shared part - what a session IS, and the rules that were paid for in
one application and apply to the other three. Per-application detail lives with the application:
[core-service](services/core-service.md) for Canari, `../MiGallery/docs/wiki/authentication.md`,
`../le-cercle/docs/wiki/authentication.md`.

## The house model

**An opaque token in the cookie, and one server-side row holding everything else.** Sky's model, now
MiGallery's and the Cercle's.

Canari is the one variant, deliberately: its 1 h access token stays STATELESS, because six services
and nginx verify it without touching a database. The row backs the REFRESH token instead, and carries
`sid` + `jti` (`apps/core-service/src/auth/auth-sessions.service.ts`).

## What a cookie is, and is not

- **A cookie whose content IS the identity it claims is not a credential, it is a form field.**
- `httpOnly` stops other people's JavaScript from READING a cookie. Nothing stops the holder from
  WRITING one. It is an XSS mitigation, never an authentication mechanism.
- "Hard to guess" is not a defence for an id that an ordinary endpoint hands to any logged-in user.
- A logout that only clears the cookie has revoked nothing. Deleting the row is the whole point.

## Rotation, replay, and the race

A refresh token rotates: each use issues a new one. That creates three problems, and they have to be
solved together.

**A replayed token is TWO holders of one cookie: revoke the session.** Detecting a replay and only
LOGGING it rotates the token for whoever presented it - the theft succeeds, with an alarm attached.

**But that rule is unsafe without a grace window.** Two tabs share one cookie, so exactly one wins the
rotation and the loser is one generation behind through nobody's fault. Keep the replaced `jti` valid
for ~60 s and hand back the CURRENT token, rotating nothing. Rejecting a replay without revoking is
not a safer middle ground: it signs out whoever LOST the race and leaves the session to whoever won,
and the loser is as likely to be the real user.

**Settle the race in SQL** - one conditional `UPDATE ... WHERE "tokenId" = :presented` - never by
reading the row and then writing it. Read-then-write is not a narrow window when something SLOW sits
between the halves: the Cercle had a network call to Canari there.

**Put revocation and expiry in that same `WHERE`**, or a session revoked mid-request is rotated back
to life by the request that was already in flight.

**The grace window is also what makes claiming the rotation BEFORE issuing the token safe:** if
signing then fails, the browser still holds the `jti` just recorded as previous, so the next request
is reissued instead of being read as a replay.

## The rotation has to reach DISK, and on Android nothing guarantees that

Rotation makes the credential's durability part of the protocol: from the instant the server answers,
the ONLY acceptable token is the one it just set, and the previous one becomes a replay 60 s later.
A client that loses the new value therefore does not merely fail to refresh - it gets its session
revoked.

On Android the refresh token lives in exactly one place: the WebView's Chromium cookie store, which
is committed to disk on a lazy timer. `CookieManager.flush()` is the only way to force it, and
`MainActivity` called it from `onPause`/`onStop` only. A process death with no lifecycle callback
(`am force-stop`, a crash, an OS kill, an APK reinstall) therefore reverted the on-disk cookie to the
generation BEFORE the last rotation, and the next cold start presented it. Inside the 60 s grace
window the reissue hides the problem completely; outside it, the server reads a replay and deletes
the session row - permanently, and correctly, by the rule above.

Proven on production 2026-08-06 (WP-ANDROID-SESS-1), in both directions, using the grace window
itself as the instrument: force a rotation with the app foregrounded, kill it, relaunch inside 60 s
and read the row back. Without a flush the row had not moved, so the phone had presented the
superseded token; with a HOME press before the kill it had rotated again, so the phone had presented
the current one. The server's own log for the original failure says `Refresh token replay detected
sid=… - session revoked`, in the same second as the phone's `refresh 401`.

Two rules come out of it, and they generalise past Android:

- **A rotating credential must be durably written before it is relied upon.** Every response that may
  carry a `Set-Cookie` for the refresh cookie - login, refresh, logout - is followed by an awaited
  `flush_webview_cookies` (`frontend/src/lib/utils/androidCookies.ts`, a Tauri command that reaches
  `android.webkit.CookieManager` over JNI). Awaited, not fire-and-forget: returning before the bytes
  are on disk leaves exactly the window it closes.
- **A dead session must be visible.** The 401 is reached in one place, so the reaction is announced
  from that one place (`setSessionExpiredHandler` in `frontend/src/lib/stores/auth.ts`) rather than
  re-decided by each caller. `apiFetch` used to swallow the error and retry the request
  unauthenticated, which turns "you are logged out" into "there is nothing here" - the app rendered
  its ordinary shell, empty, with no login screen. Only a TRANSPORT failure now earns the anonymous
  attempt.
- **A verdict reached before anything is listening must be REPLAYED, not dropped.** The reaction is
  owned by the app shell, which registers it on mount - and on a cold start the first refresh 401s
  before that, so the fallback redirect was the entire reaction. A redirect is not the reaction: it
  skips `dismissAuthPrompts()` and `clearAuth()`, so Android landed on `/login` with the encryption
  PIN modal still open OVER the sign-in button, and the user could not get back in at all (measured
  2026-08-06, on the build that had just fixed the two faults above). `setSessionExpiredHandler`
  therefore fires a handler that arrives after the verdict. The general form: a one-shot announcement
  and a late subscriber are a race, and the fallback that "covers" it is only equivalent if it does
  everything the real handler does - which it never does, or it would BE the handler.

Both halves were verified on an Android device on 2026-08-06, against production. Persistence: two
rounds of rotate -> `am force-stop` -> wait past 60 s -> relaunch, and in both the row's
`previousTokenId` was exactly the token the app had flushed, so the phone presented the current one
and the session lived. Visibility: revoking that session from another client's "Connexions actives"
panel and cold-starting the phone put it on `/login`, with `session dead -> logout` and
`session expired on GET … - no anonymous retry` in its log.

## Third-party cookies, and the shell that is not the backend

The refresh cookie is FIRST-party on the web and THIRD-party in every native build, and nothing in
the code says so - the asymmetry lives entirely in what the browser considers the document's origin.
On `canari-emse.fr` the page and the API share a host, so `canari_refresh` is an ordinary same-site
cookie. In a Tauri build the document is `tauri://localhost` (iOS, macOS, Linux) or
`http://tauri.localhost` (Android, Windows) and the cookie belongs to `canari-emse.fr`: a
cross-origin `Set-Cookie`, which is exactly the class every modern engine blocks by default.

- **Android**: blocked by default and opted back in, in ONE line, with the reason written next to it -
  `CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)` in
  `MainActivity.onWebViewCreate` (`frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MainActivity.kt`).
  This is why Android sessions survive a restart at all, and it is the counterpart to the flush above:
  one line makes the jar ACCEPT the cookie, the other makes it KEEP it.
- **iOS**: WKWebView applies the same block through ITP and exposes **no public API to lift it**. There
  is no line to add, so there is nothing to audit - which is precisely how this stayed invisible while
  the parity table above was being maintained.

**What it costs if ITP does drop the cookie, and why login still looks fine.** The access token comes
back in the response BODY and is kept in memory, so the sign-in the user just performed succeeds and
the app works for that whole session. Only the NEXT cold start pays: `POST /api/auth/refresh` arrives
with no cookie, and the server can only answer 401. The failure is therefore separated from its cause
by an app restart, and presents as "it logs me out every time" rather than as anything about cookies.

**MEASURED, both sides, 2026-08-27, and the two devices answer differently on the same server in the same
minute.** The 401 has two indistinguishable causes - a person who genuinely has no session, and a jar
that refused the cookie - so the branch in `auth.controller.ts` (`@Post('refresh')`) prints the cookie
NAMES it received, the `Origin` and the user agent, and warns rather than debugs when that origin is a
native shell, because a native client only asks for a refresh once it believes it has a session. What
it printed settles the question:

| Device | `POST /api/auth/refresh` | Cookies presented |
|---|---|---|
| iPhone, iOS 18.7 | **120 x 401** in 45 minutes | `cookies=[]`, `origin=tauri://localhost` |
| A1 (Pixel 6a), after `am force-stop` | **1 x 200** in 218 ms, then `[PIN] Device key restored` | the cookie |
| Web | 401 on anonymous loads only | `cookies=[cf_clearance]` |

**The line grew a third field once the header transport shipped, because the 401 grew a third cause.**
A client too old to carry its own credential and a client whose store write FAILED both arrive with no
cookie AND no header - a body-transport client with an empty store correctly sends none - so nothing
above separates them, and one is expected while the other is a defect. The refresh request therefore
states its own version as a `clientVersion` query parameter, exactly as `users/me/announcement` does
and for the same reason (nothing in a request carries it; a query parameter also needs no CORS
allowance on four services, which a second custom header would), and the refusal prints it as
`client=`, or `client=unstated` for a build older than the parameter. The header's own state is three
values, not two: `absent`, `empty`, and `ignored` for an origin whose policy is to keep its cookie -
calling that last case `empty` accuses a healthy request, which is what the first version of the field
did.

So Android's opt-in works and survives a kill; WKWebView's refusal is total. There is no iOS flag to
add, no entitlement, no `Info.plist` key - and the two ways to make the cookie first-party both cost
more than they buy (serving the app from `https://canari-emse.fr` inside the WebView would end
offline launch, and Tauri has no https-origin mode on iOS anyway).

## The cookie's own attributes are a DEPLOYMENT fact, not a per-request one

`secure` and `sameSite` decide whether a refresh credential crosses the network protected. Until
2026-09-01 `auth.controller.ts` decided them per request, from `Origin` or `Referer`:

```ts
if (this.isProduction) return false;
const origin = req.get('origin') || req.get('referer') || '';
return origin.includes('localhost') || origin.includes('tauri.localhost');
```

**Two things were wrong with that, and the second is why it had to change now.**

- **`Origin` is written by the caller.** Outside production, anything sending
  `Origin: http://localhost` was handed a refresh cookie with `Secure` off and `SameSite=lax`, on the
  strength of a header it chose itself. Production was safe - `isProduction` short-circuits - so the
  exposure was confined to any deployment whose `NODE_ENV` was not `production`, which is exactly the
  state a new environment starts in.
- **A SECOND HTTPS ENVIRONMENT WAS UNREPRESENTABLE.** The only way to ask for production's attributes
  was to *be* production. `dev.canari-emse.fr` is served over HTTPS behind the same tunnel and must
  keep them, so the domain could never be the discriminator - and the rewritten
  `docker-compose.dev.yml` had in fact left `NODE_ENV` off all four NestJS services, which would have
  put a live HTTPS environment straight into the origin-sniffing branch.

So the decision is now read once, from configuration, and there is deliberately **no default**:

- `NODE_ENV=production` forces the safe attributes, and `ALLOW_INSECURE_COOKIES=true` alongside it is
  a startup **error** rather than something silently overridden - a deployment that believes it asked
  for one thing should not be told nothing.
- Whenever `NODE_ENV` is anything else, `ALLOW_INSECURE_COOKIES` must be explicitly `true` or
  `false`, or the controller refuses to start and names both values in the message. A variable nobody
  set is not an answer to "may this credential travel unprotected".
- `true` belongs to `infrastructure/local/` alone, which is served over plain HTTP on localhost where
  a `Secure` cookie is never sent back. Every deployed estate uses `false`, and CI's
  `boot-nest-apps` job sets `false` so it exercises the same branch.

`clearCookie` reads the same field, because the browser only drops a cookie when the attributes
match - a second copy of the decision would be a way for logout to silently stop working.

Two derived tests hold the wiring: `compose-wiring.test.sh` requires every NestJS service in a
deployed compose file to declare `NODE_ENV`, with the service list read out of `apps/*/package.json`
rather than written down, and `auth.controller.spec.ts` asserts the attributes are identical for
`Origin: http://localhost` and `Origin: https://canari-emse.fr`.

## The credential a client carries itself

Where the cookie cannot live, the credential travels explicitly: sent in `X-Canari-Refresh`, returned
in the response body, and kept between launches in a store file. Both halves decide from the SAME TWO
FACTS - the request's `Origin` and `ALLOW_INSECURE_COOKIES` on the server (`refresh-transport.ts`),
the document's scheme and the API's scheme on the client (`nativeRefreshToken.ts`) - so neither side
infers the other's platform, and nothing is learnt by being refused.

- **Two reasons a cookie cannot be kept, and they are not the same reason.** The ENGINE:
  `tauri://localhost` is WKWebView, which blocks the third-party class through ITP and publishes no
  opt-in, so those clients carry the credential on every deployment including production. The
  DEPLOYMENT: `setRefreshCookie` can issue `SameSite=None; Secure` over HTTPS and only
  `SameSite=Lax` over plain HTTP - `None` requires `Secure`, `Secure` requires TLS - and **a `Lax`
  cookie cannot be SET in a third-party context at all**.
- **So `http(s)://tauri.localhost` - Android and Windows - takes the cookie path wherever one can be
  issued, which includes production and `dev.canari-emse.fr`.** Its durability there is proven on
  hardware (WP-ANDROID-SESS-1) and that is not re-decided. Against a PLAIN-HTTP deployment it takes
  the header path, because there is no cookie for it to keep.

  **Measured 2026-09-04, on the local estate.** `Network.getAllCookies` returned 0 matching cookies
  on the phone against 3 in a browser; the server logged `no canari_refresh cookie. cookies=[]
  x-canari-refresh=absent origin=http://tauri.localhost`; `auth_sessions` held three Android rows
  created and never used again, `rotatedAt` NULL and `lastUsedAt` equal to `createdAt`. The device
  logged itself out before it had published a key package, so it could be added to no group - which
  blocked every phone row of the campaign, on the estate rather than on the product.

  **Serving the local estate over TLS was tried first and does not work**, which is why the fix is
  here instead: the phone's API calls go through the Tauri http plugin, which is Rust `reqwest`
  built against `webpki-roots` with no platform verifier, so it trusts the bundled Mozilla root set
  and nothing else - not the Android system store, not a user CA, not a network security config. A
  private certificate cannot be made to work on that client at all.
- **The cookie is still SET for everyone**, including the clients that will drop it. It is unreadable
  by the page's own JavaScript, so it stays the better credential wherever it survives - and
  `tauri://localhost` is also macOS and a Linux desktop build, where nobody has measured whether it does.
  Reading it when no header arrives is therefore a shim over an UNKNOWN population, not just an old
  one, and it is registered as such in
  [`legacy-compatibility.md`](legacy-compatibility.md) with a removal condition that requires that
  measurement first.
- **The header wins when both are present.** A client that sends one is maintaining its own copy and
  rotating it; the cookie beside it is a value it stopped updating.
- **The write is AWAITED, and that is the whole design.** Rotation makes durability part of the
  protocol, exactly as it does on Android: from the instant the server answers, the previous value is
  spent and becomes a replay 60 s later, which deletes the session row. So `autoSave` is OFF on that
  store - a debounced write is precisely the hazard - and `writeNativeRefreshToken` does not return
  until `save()` has. The Android incident above is what this is copying.
- **An empty store is NOT proof of no session.** On the same origin a desktop build may hold a working
  HttpOnly cookie that this code cannot see by design, so the request is still made; the header is
  added only when a copy is actually held.

**What it costs, stated plainly:** on those platforms the credential is readable by the app's own
JavaScript instead of being `httpOnly`. It is the same trade Android already makes in substance - its
refresh token sits in the Chromium cookie file inside the app sandbox - and the file used here has the
same protection class (iOS Data Protection, app container). Moving it into the platform keychain
without biometric flags is a strict improvement on BOTH platforms and is filed as one
([`backlog.md`](backlog.md)); it needs a new command in the vendored plugin, so it is not this change.

The general rule: **a cookie a native shell depends on is third-party by construction, and whether it
survives is decided by TWO parties.** The question is never "does the server set the cookie" but "can
this deployment issue one this engine will keep" - and where the answer is no, for either reason, the
credential stops being a cookie there. Asking only about the engine is what left the Android client
correct on production and silently sessionless everywhere else.

## One session per device, enforced where the device becomes KNOWN

A session and a device are two records of one physical thing, held by two services. Canari joins them
on `auth_sessions."deviceId"`, written once per app start by `PUT /auth/sessions/current/device`
(2026-08-17). Two results came out of doing it, and both generalise.

**The login endpoint cannot be the place that supersedes the old session.** It creates a row and
overwrites the cookie, so the previous row is unreachable from that browser the instant the callback
returns - and yet it stays valid for the full idle lifetime. The obvious fix, deleting the user's
other sessions at login, is wrong: at that moment the only discriminator the server holds is the
USER, which would also sign the phone and the desktop out. The discriminator that separates them
arrives later, at unlock. So the decision moves to where the fact is known rather than the fact being
guessed where the decision is convenient.

**A second live session naming one device is unreachable BY CONSTRUCTION, so it can be destroyed
without a heuristic.** A browser profile holds exactly one refresh cookie and one device identifier;
so does an app install. Whatever else claims that device is either abandoned - cleared cookies, a
reinstall, a login that never signed the old one out - or held by somebody else. Both readings end
the same way, which is why `bindDevice` deletes them and logs it as a WARN rather than reporting a
count nobody reads. Measured before the change: 47 users with a live session, 13 holding several,
and 2 pairs sharing one user agent.

**A null device is a state, not a gap.** A session is opened by the OIDC callback, before the client
can name a device, and a holder who never unlocks MLS never names one at all - which is the shape a
stolen cookie takes. The settings panel gives such a row its own entry instead of hiding it under a
device it cannot claim.

## Keys

- **An empty key can fail OPEN or CLOSED and you cannot guess which.** `crypto.createHmac('sha256','')`
  signs happily, so anyone can forge; jose refuses a zero-length key. Decide explicitly rather than
  inheriting whichever behaviour the library happens to have.
- `TextEncoder().encode(undefined)` is NOT the key `"undefined"` - the WebIDL default makes it ZERO
  bytes. It only fails open where the value is STRINGIFIED first, because `"undefined"` is a valid
  9-byte key.
- **One key signing two token KINDS means each verifier must check the kind.** A refresh token
  verifies wherever an access token does, so without a `type` guard it authenticates its holder for
  7 days.
- **Never `JWT_OLD_SECRET`.** Its second step - removing the old value - is invisible and never
  taken, and it is backwards for the case you rotate in. Rotating the signing secret is the hard cut;
  the everyday lever is the session row.

## Impersonation

**It belongs in the session ROW, never in a second cookie.** A parallel credential outlives the logout
of the first, and nothing can then prove who really acted.

Authorise STARTING one on the effective user and STOPPING one on the real user - that split is the
design. An audit trail names the account that ACTED, so it reads the real user, not the worn identity.

## Implementation traps

- A SvelteKit `redirect()` is not an `Error`, so `catch (e) { if (e instanceof Error) ... }` swallows
  it and answers 500 on a handler that worked. Throw redirects OUTSIDE the try.
- An id generated by the DB drags an extension in (`uuid_generate_v4()` needs `uuid-ossp`), so TypeORM
  `synchronize` in dev and the prod migration stop describing the same table. Generate it in Node.
- **Take the client IP from the LAST `X-Forwarded-For` entry.** nginx APPENDS the connecting address
  to whatever the client sent, so the head of the list is attacker-controlled.
