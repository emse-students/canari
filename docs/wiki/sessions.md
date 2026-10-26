# Sessions, in every application

Canari, Sky, MiGallery and Le Cercle all sign users in, and by 2026-08-04 all four run the same
session model. This page is the shared part - what a session IS, and the rules that were paid for in
one application and apply to the other three. Per-application detail lives with the application:
[core-service](services/core-service.md) for Canari, `../MiGallery/docs/wiki/authentication.md`,
`../le-cercle/docs/wiki/authentication.md`.

## The house model

**An opaque token in the cookie, and one server-side row holding everything else.** Sky's model, now
MiGallery's and the Cercle's.

Canari is the one variant, deliberately: its 1 h access token is a signed JWT the six services never
look up. The row backs the REFRESH token, and carries `sid` + `jti`
(`apps/core-service/src/auth/auth-sessions.service.ts`) - and since 2026-10-25 the verifier every
`auth_request` location runs, `/api/auth/verify`, also reads that row by `sid`, so through those
locations an access token lives no longer than its session ([below](#an-access-token-is-only-as-alive-as-its-session-2026-10-25)). On Android a session may also
own ONE restore key, which dies with the row and moves the session to a new phone rather than adding
one ([account-restore](account-restore.md)).

## What a cookie is, and is not

- **A cookie whose content IS the identity it claims is not a credential, it is a form field.**
- `httpOnly` stops other people's JavaScript from READING a cookie. Nothing stops the holder from
  WRITING one. It is an XSS mitigation, never an authentication mechanism.
- "Hard to guess" is not a defence for an id that an ordinary endpoint hands to any logged-in user.
- A logout that only clears the cookie has revoked nothing. Deleting the row is the whole point.
- **And deleting the row ends Canari's session, not MiConnect's.** The identity provider keeps its
  own cookie, which answers the next sign-in as the account that left. A sign-out somebody chose
  ends that one too, through end-session, with the id_token the OIDC callback hands the client for
  that ONE use - not a credential anywhere, see
  [auth](frontend/modules/auth.md#signing-out-ends-the-miconnect-session-2026-10-14) (2026-10-14).

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

**Every refusal of a refresh LOGS WHICH ONE IT WAS, at `warn`, because every one ends in a
sign-out** - the token does not verify (with the error's class), the wrong token type, no session in
the token, a replay, and the session row missing or expired. Until 2026-09-28 three of them were
silent, and a dev sign-out right after dev's database was replaced from production's could only be
explained by correlating the 401's body length with the refresh job's clock.

## Every first-party request has a deadline, the refresh and the sign-out included (2026-10-16)

Until 2026-10-16 `apiFetch` bounded its response head and the two auth calls did not: `_doRefresh`
and `clearAuth`'s `POST /api/auth/logout` were plain `fetch`es. `apiFetch` awaits `getToken()` first,
so on a stalled or captive link at a cold open every request waited behind a refresh held for the
engine's own timeout (minutes), and a sign-out hung with no feedback. Both now go through
`trackedFetch` (`frontend/src/lib/utils/trackedFetch.ts`), the one place a deadline and the
connectivity signal are applied, and an expiry is a `RequestDeadlineError`: a transport failure,
never an answer, so it can never log anyone out.

**The refresh's number comes from the rotation, not from the link.** The server rotates on RECEIPT,
so a deadline can abandon a refresh it already executed and lose the new token. That loses the
response, not the session: the replaced `jti` is answered with the CURRENT token for
`ROTATION_GRACE_SECONDS` (60 s, see above), rotating nothing - **provided the old token is presented
again inside that window.** "The next `getToken` caller is the retry" does not guarantee that,
because there may be no next caller: a cold start's `hasStoredSession` swallows the failure and
leaves the user on the login screen, the no-network gate holds refreshes until a reconnect, and a
backgrounded app makes no call. A slow-but-alive refresh abandoned at its deadline could then be
followed by nothing until the grace ran out, and the next refresh would revoke the session as a
replay - where before the deadline it simply succeeded (adversarial review of #1966, 2026-10-16).

**So a refresh whose head missed its deadline is re-sent ONCE, at once, with the SAME credential**
(the stored copy where the client carries it in `X-Canari-Refresh`, the jar's current cookie
otherwise), inside the shared single-flight promise. The server makes that safe by construction: if
the first request never arrived, the re-send rotates normally; if it did, the re-send gets the grace
answer. Never a double rotation. `REFRESH_DEADLINE_MS` is the read class's 20 s, and the call is
labelled `read`, because what the policy needs is a call that may be re-sent once without a second
effect - what a GET is, and what this POST is inside the grace. The bound that must fit in the 60 s
grace is the RE-SEND'S ARRIVAL, about one deadline (20 s) after the rotation the first request
caused - not the 40 s the two deadlines take in total. **One case is accepted:** an abandoned
original delivered to the server MORE than 60 s after the re-send rotated would read as a replay
and revoke the session; any retry of a rotating request has that case, and no deadline removes it. A
second deadline rejects as a `RequestDeadlineError`, and a 401 on the re-send is the dead session it
always was. No deadline is the worse case: an engine giving up after minutes has lost the same
response AND spent the grace.

**The sign-out is awaited, under `LOGOUT_DEADLINE_MS` (the write class's 30 s), and the local sign-out
completes whatever the server did.** The button says it is busy for that wait and ignores a second
tap, which would send a second logout (`Navbar.svelte`). Awaited because the web sign-out navigates the document to
MiConnect's end-session next ([auth](frontend/modules/auth.md#signing-out-ends-the-miconnect-session-2026-10-14)),
which would abort a request in flight. A sign-out past the deadline, or answered with a non-2xx, says `the server did NOT revoke
the session` at `warn`, because the row then lives on: where the cookie is the credential (web,
Android) it is still in the jar, since only the server's `Set-Cookie` clears an HttpOnly cookie. On
the native transport (iOS) the stored copy is cleared locally either way.

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

**A desktop browser has the same hole and no flush to close it** (KILL-2, 2026-10-25): Chrome
commits its cookie store about every 30 s, and a hard kill inside that window, after two rotations,
reproduced the replay and the sign-out. It is an open P2 in [backlog](backlog.md), with its
reproduction and a candidate server-side fix.

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

**A replay line says WHICH replay it was (2026-10-06).** Three `Refresh token replay detected` events in
30 h of production came from one native iPhone, and nothing could separate the two causes that end in
that revocation. The line now carries `presented=previous|older` and `rotatedAgo=<s>`:
`previous` outside the 60 s window is a client that LOST the response of its last rotation (iOS
suspended between the server's rotation and the client's awaited store write, so the stored copy is
one generation behind); `older` is a token spent two or more rotations ago, a real fork. **Paths
cleared by reading, 2026-10-06:** no second JS context refreshes (the Rust side and the Swift/Kotlin
code never call `/api/auth/refresh`; `bench.rs` only deletes the stored key), `_pendingRefresh` is set
synchronously and cleared only after the awaited store write, every other caller goes through
`refresh()`. **Open, by construction and not yet observed:** a lost response older than the grace
window is revoked as a replay; if the next replay line reads `presented=previous` with a large
`rotatedAgo`, the fix is to end the grace on proof of receipt rather than on a clock. Not built before
that line has been seen.

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

## An access token is only as alive as its session (2026-10-25)

**`/api/auth/verify` answers an access token whose session has ended exactly as it answers an expired
one: anonymous.** Every location nginx guards with `auth_request` runs that verifier, and every
guarded route behind it reads the `X-Logged-In` it sets, so from the commit that deletes a session
row - a sign-out, the owner removing it from the device panel, "sign out the others", a replay, a
restore, an owner's device revocation (below) - every request through those locations carrying a
token minted for it is a 401. The client meets that 401, renews, is refused the refresh, and signs
out.

- **One rule, one implementation.** `AuthController.sessionOfToken` decides it for `check` (the
  verifier) and for `requireAccessToken`, the reader of core-service's own `/api/auth` routes that
  take the bearer token themselves. `AuthSessionsService.isLive(sid, sub)` is a primary-key read
  beside the platform config the verifier already reads. Every ending of a session DELETES its row,
  so absence is the ended state; `expiresAt` is compared too because an idle-expired row may not have
  been swept yet. No cache and no clock: the deletion is what flips it.
- **A token naming no session is ACCEPTED, by construction - and the branch has a removal date.**
  The one issuer (`signAccessToken`) always writes `sid`, so a sid-less token was minted by a release
  older than this check, before its deploy, and dies by its own `exp` within one
  `ACCESS_TOKEN_TTL_SECONDS` of it. Refusing it would answer every client signed in at the deploy
  anonymous for up to that hour. No session is read for it, `X-Session-Id` stays empty, and the
  acceptance is logged ONCE per process at `log`, not per request. The branch is deleted one token
  lifetime after the deploy ([legacy-compatibility](legacy-compatibility.md)). The dev estate cannot
  rehearse it: its tokens already carry `sid`.
- **An ended session is said once.** The refusal is logged at `warn` the first time per session per
  process (a bounded set of 4096 ids), then at `debug`: a client sends several requests before its
  refresh is refused, and the refusal is one fact.
- **A failed read is not an answer.** It propagates as a 5xx - nginx fails the request, and a client
  keeps its session on a 5xx; it is never turned into "anonymous" (which would sign a user out on a
  database hiccup) nor into "logged in" (which would let an ended session through).
- **Exactly what it covers.** (1) Every HTTP route behind an `auth_request` location - in particular
  every device-creating call: device registration, key-package and prekey publication, commits and
  external joins, add locks, Welcome requests, invitation accepts, push registration. (2) The
  `/api/auth` routes that read the bearer token themselves through `requireAccessToken`: the session
  list, a session's revocation, "sign out the others", binding the current session to its device,
  the account-restore registration, and the adminer session.
- **Exactly what it does not.** Three families verify the access token THEMSELVES and do not read
  the session: media-service's own token check, call-service's claim decoding, and the gateway
  WebSocket, which authenticates its `canari_ws_token` cookie at the upgrade (a socket open, or
  opened within the token's hour, is not cut by an ending). None of them creates a device. Their
  liveness is tracked privately ([backlog](backlog.md)). The push-secret background routes are not
  behind the verifier either: a session's ending deletes its push registration and with it the secret
  those routes check (below). The settings panel says all three in as many words
  (`settings_sessions_delay_note`).

**An owner's device revocation ends that device's sessions server-side.** When chat-delivery records
an OWNER's ban on a device id (`DELETE /mls/devices/:userId/:deviceId`,
[chat-delivery](services/chat-delivery.md)), it asks core-service
(`DELETE /api/internal/sessions/users/:userId/devices/:deviceId?exceptSession=`, internal secret)
to end every session of that user BOUND to that device (`auth_sessions."deviceId"`, written by
`bindDevice`) except the caller's own, through `AuthSessionsService.endDeviceSessions` - the same
`DELETE ... RETURNING` + push-ending transaction as every other ending, cause `revoked-by-owner`. If
that call fails the delete answers 503 (`DeviceSessionsNotEndedError`, never swallowed), after the
ban is written and the device signalled; the device panel signs the row's logins out itself on any
answer (`removeDeviceRow`), and a login that survives stays listed as its own row for the user's
retry. A retirement (`reason=retired`) ends none - the id
was the caller's own install's. Not covered, stated: a session bound to NO device, or to a different
id - the panel's own session revocation (`DELETE /api/auth/sessions/:id`) ends those.

## A refresh refused because the device was revoked says so (2026-10-25)

**Ending the device's sessions destroyed the only fact the device could still learn its revocation
from.** Measured on the rig (DEV-2, `1.4.1-alpha.4`): the `device_revoked` frame arrived; the frame's
own check, `GET /api/mls/devices/:u/:d/revoked`, was asked with the access token the revocation had
just killed (the verifier reads the session, above), its renewal was refused, and the client read
that as "unreachable - NOT revoked" and logged `the server disagrees`. The device left only through
the generic expiry sign-out, which keeps every local store by design. A device offline during the
revocation (DEV-3) got no frame at all, and the same sign-out. Both came with the server-side session
ending of the same release; `v1.4.0` and older do not end the device's sessions, so their check is
answered and the frame wipes.

**The cause is carried to where the device decides, from where it is known.** `endDeviceSessions`
writes one `device_revoked_sessions` row per session it deletes (core-service migration 017), in the
same transaction. A refresh whose session row is missing reads it by `sid` and is refused
`401 { statusCode, code: 'DEVICE_REVOKED_BY_OWNER', userId, deviceId }` - the code from the shared
refusal registry, the session's own account and device NAMED, and Nest's envelope kept, so an older
client reads the 401 it always read. Every other ending (logout, the panel's session revocation, "sign out the
others", a replay, expiry) stays the plain 401: the record answers ONE question, "did an owner's
DEVICE revocation end this session".

**Kept exactly as long as it can be asked.** A refresh token naming the session expires at most
`SESSION_TTL_SECONDS` after its last rotation, which came before `endedAt`; past `endedAt + TTL +
CREDENTIAL_SKEW_SECONDS` it fails to verify before the session is looked up, so the hourly session
sweep deletes the record then - a proof, not a guess. Erased with the account.

**The client** (`stores/auth.ts`) types the refusal at its throw as
`SessionEndedByDeviceRevocationError` (a `SessionExpiredError`, so every consumer that stops on a
dead session still stops - by `instanceof`, never by name, which is what let the subclass through to
a reconnect ladder) and latches the device it names beside the dead-credential verdict
(`revokedDeviceOfEndedSession`); a new credential clears both. A refusal that names no device, is not
JSON, or carries neither Nest's envelope nor a registry code (an edge page) is no revocation. Three
things read it, and they converge on ONE reset ([auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it)):

- the session-expired reaction (`handleSessionExpired` -> `settleSessionEndByRevocationImpl`) reads
  the LATCH, not its caller, and resets ONLY when the named device is this install's current device
  id of the saved account - a session bound to an id the install has since rotated away from, or to
  another account, is the plain sign-out that keeps the stores. Order of arrival never matters, and
  the offline return (no frame) is covered by the same line;
- the frame's check (`isDeviceRevoked`) answers `true` on that typed refusal when it names the device
  asked about, `false` on another device, any other dead session or a transport failure;
- `wipeRevokedDevice` runs once per device: a discoverer during the run joins it, and one after it
  finds the device in the page's completed-reset record and erases nothing again.

**What a rig row must observe** on the revoked device: `[A] session dead: a device was revoked by its
owner → reset if it is this one`, `[SECURITY] Revoked-device reset starting.`, `[RESET] done - nothing
of this device remains`, and on the live variant also `revocation check: the server ended this
session BECAUSE the device was revoked` and `Revoked-device reset already running - joined`. Never

**Designed outcomes of that end, and how they log (2026-10-26).** The reset's own `clearAuth` IS the
device's one sign-out: the frame path hands `onSessionExpired({ alreadySignedOut: true })` and the
refusal path's `settleSessionEndByRevocation` answers `true`, so `handleSessionExpired` redirects
without a second `POST /api/auth/logout`. A pending fetch refused with the typed error naming THIS
device ends with one info line (the server deleted the backlog; nothing remains to drain), never an
error claiming it stays queued.
`the server disagrees`, and no `Gateway inaccessible` after it.

**The cases this record does not reach** are a design limit, listed with what covers them in
[backlog](backlog.md#a-revoked-device-whose-refresh-cannot-name-its-revocation). Tests:
`auth-sessions.service.spec.ts`, `auth.controller.spec.ts`, `session-push-end.integration.spec.ts`,
`auth.deviceRevoked.test.ts` (the named body, an HTML and an edge 401), `BaseMlsService.revokedFrame.test.ts`,
`session/revokedDeviceReset.test.ts` (both orderings, the offline return, a late discoverer, a
rotated device id, another account, a transport failure, a plain expiry),
`startGatewayHandshake.test.ts` and `signOutInProgressReconnect.test.ts` (the reconnect stops).

## A session that ends takes its device's push registration with it (2026-10-22)

**After any sign-out, the device stops being a push destination for the account that left - on
both sides, and neither depends on the other.**

**Server.** Every path in `AuthSessionsService` that deletes a session deliberately ends the push
registrations it leaves behind: `revoke` (the logout), `revokeOwned` (the owner revoking a device),
`revokeOthers`, and the replay that revokes in `rotate` - and so does the one deletion OUTSIDE it, a
restore consuming its key (`RestoreCredentialsService.consume`, cause `restored`), which ends the old
phone's session in its own transaction and enqueues through the same `SessionPushEndService.enqueue`
([account-restore](account-restore.md)). A new deletion of `auth_sessions` that skips the enqueue
leaves a sold or lost phone receiving the account's notifications. Three facts make it exact and
durable by construction:

- **The registration names its session.** An access token carries `sid`, the session it was minted
  for (`signAccessToken`); `/api/auth/verify` answers it as `X-Session-Id`, nginx forwards it on every
  authenticated location (and empties a client's own), and `POST /mls/push/register` stores it in
  `push_token."sessionId"` (chat-delivery migration 037) on every registration, null included. A row
  written before the column, or with an access token minted before the claim, holds NULL; there is
  no backfill.
- **The ending is part of the session's deletion.** The same transaction that deletes the session
  writes one `session_push_endings` row (core-service migration 016) for EVERY deliberately ended
  session, with the device it named or NULL (`DELETE ... RETURNING` for `revokeOthers`). A failure
  rolls both back.
- **One pass deletes exactly what the session left.** `DELETE /api/internal/push/users/:userId/
  sessions/:sessionId` deletes the row that session registered, on whatever device - a session that
  registered before `bindDevice` named its device is covered. When the session named a device, the
  pass first READS that device's binding (`GET /api/internal/push/users/:userId/devices/:deviceId`),
  then judges it in core-service: NULL, or a session absent from the live `auth_sessions`, is stale;
  the ending session itself, or a live session, is left. A stale binding is sent back as
  `?device=&ifBoundTo=<session|none>` and deleted only if the row still names it - so a re-sign-in
  that registers between the read and the delete changed the binding, and is never reached. A
  device whose earlier session died without an ending therefore loses that stale row with its
  current session's sign-out.

**A final pass, because a request can be in flight across the ending.** Since 2026-10-25 an access
token whose session has ended is answered anonymous at the verifier
([above](#an-access-token-is-only-as-alive-as-its-session-2026-10-25)), but a registration whose
`auth_request` answered just before the session's deletion committed still reaches chat-delivery
afterwards, carrying the ended session's id - and a node rolled out before that change does not check
at all. So a pass that succeeded before `endedAt + ACCESS_TOKEN_TTL_SECONDS +
CREDENTIAL_SKEW_SECONDS` keeps the row, due at that instant, and the row is deleted only after a pass
that STARTED after it - the account erasure's `afterSuccess` rule, a termination proved by the
token's own expiry. `SessionPushEndService` drains the outbox exactly as `AccountErasureService`
drains `account_erasure_jobs` ([account-erasure](account-erasure.md)): right after the commit,
unawaited - a slow chat-delivery never turns a logout into a refusal - and every 60 s, a claim under
`FOR UPDATE SKIP LOCKED` with a lease, `INTERNAL_SECRET` on each call. A 2xx (`removed: 0` included:
the second call of an idempotent end) advances the row as above; a 5xx or a transport failure keeps
it with its attempts and last error, retried with backoff (30 s doubling, 6 h cap) and logged at
ERROR with `[PUSH_SESSION_END]`, its attempts and its age; a 400 - an address chat-delivery refuses,
which no retry can change - is accused once at ERROR and the row dropped. `bindDevice` refuses any
device id outside `libs/contracts/device-id.json`, the pattern chat-delivery accepts, so a session
cannot name a device whose ending would be refused.

Deleting the `push_token` row removes the destination AND the push secret on it, so every
PushSecret-authenticated background path is refused from then on, and `refresh-token` only ever
updates a row, so nothing on the device can bring it back. `bindDevice`'s strays never record an
ending: they name the very device being bound, whose registration is the live session's.

**Device.** `clearAuth` - which every sign-out calls - runs `endPushRegistration`
(`PushNotificationService.ts`) whatever happened before: a dead credential, a refused network, no
registration marker in the tab, no app shell. Through `end_push_registration`
(`src-tauri/src/commands/push_registration.rs`) the OS token is deleted natively, the push secret
erased, `push_context.json` reduced to the device's identity (`userId`, `deviceId`, `locale` - an
allowlist), and the iOS extension's copies removed; a push still in flight is then dropped by the
native handlers instead of shown. The mechanism, and the two durable marks it leaves, are on
[mobile](frontend/mobile.md#a-sign-out-ends-this-devices-push-registration-2026-10-22).

**What each side guarantees on its own.** The device's deletion of its OS token makes FCM refuse
that token, and the dispatcher drops the row at the next send (`registration-token-not-registered`).
The server's deletion needs nothing from the device, and is recorded with the session's own
deletion: a chat-delivery that is down delays it, and a registration made with a still-valid access
token after the first pass is taken by the final one.

**Scope.** Every delete is keyed on the account, and then on the ending session or on a binding read
and judged stale, so it cannot reach another account's registration nor a live session's. A session
that EXPIRES (7 idle days, `deleteExpired`) is not a revocation and leaves the push registration as
it is - **decided by the user, 2026-10-23: only an explicit sign-out (or a revocation) ends it, never
an expiry alone**, so an idle phone keeps its notifications, as WhatsApp's does.

**The rolling deploy, and the order accepted (2026-10-23).** The release that brings this rolls
nginx, core-service and chat-delivery-service one at a time, with no shim between the old and new
shapes (a compatibility path would be a fallback). For the minutes the three disagree: an OLD
core-service calls the removed `devices/:deviceId` delete, chat-delivery answers 404, and that
session's server-side ending is lost (the device still deletes its own token); a NEW core-service
calling an OLD chat-delivery reaches routes that do not exist yet, so its rows stay queued and are
retried until it is deployed; an OLD nginx does not yet empty a client's own `X-Session-Id`, so a
registration in that window can carry a session id the client chose - for its own account only,
since the account comes from the verified token. That window is the order accepted.

## A dead session sends the user to `/login` carrying where they were going (2026-10-09)

A post push tapped from a KILLED app whose session had been deleted server-side landed on a bare
`/login` (Mi 9T, 2026-10-08): the deep link's `goto('/post/<id>')` ran the root layout's `load`, whose
refresh answered 401, and `handleSessionExpired` (`ChatBackgroundService`) then went to `/login`
without a `returnTo` - and while that navigation is in flight the page SHOWN is still `/`. The
handler now reads `navigating.to?.url` (else the current location) through `loginAfterSessionExpiry`
(`utils/internalPath.ts`, tested) BEFORE `clearAuth` awaits, so the same `returnTo` the layout's own
redirect would have built survives; the root and the sign-in pages stay bare. Source guard:
`sessionExpiredRelease.test.ts`. The hardware reading is [check H](device-verification.md#h-deep-link-from-an-os-notification-tap---re-opened-on-android), step 4.

## A token that names another account than the local identity is refused (2026-10-10)

The MLS identity (`canari_saved_user`, the `userId` the WASM client is initialised with) comes from
local state; the session the server sees is the access token's `sub`. Two writers, nothing
comparing them: a bench phone ran with Alpha's identity and Delta's credential, the gateway
registered the socket as Delta carrying Alpha's device id, every send/history/seed request answered
`403 AUTHZ FAIL caller != requester`, and live frames were routed to an offline account.

**One comparison, where a token is obtained** (`_doRefresh` in `stores/auth.ts`, through
`checkTokenIdentity` in `stores/tokenIdentity.svelte.ts`, ids compared case-insensitively). With no
local id, or an unreadable token, there is nothing to compare and the token is used. On a mismatch:

- the token is **not published** (no memory copy, no `canari_ws_token` cookie) and the rotation is
  still persisted, so the sign-out that follows can revoke the session;
- the verdict is **latched** and `refresh()` throws `IdentitySplitError` without asking the server
  again (a request would only rotate the credential for the same verdict); `apiFetch` does not
  retry anonymously, the reconnect ladder stops, `loginImpl` stops, `promoteOfflineSession` stays
  offline, and the outbox's `canFlush` gate reads it;
- the console line **accuses** with both ids and nothing else (`IDENTITY SPLIT: ...`);
- **nothing is wiped.** The MLS state belongs to whoever signs in as the right account;
- `IdentitySplitOverlay` (mounted in the root layout) blocks the app with ONE action, the ordinary
  sign-out (`clearAuth()` then `/login`). `clearAuth` and a new OIDC callback lift the latch.

**A 403 on a send is an answer, classified at the throw.** `postApplicationMessage` raises
`SendForbiddenError` (an `ApiRefusalError`, status 403) for every 403 that is not
`sender_not_active`; the outbox reads the status from the type, keeps the entry (nothing the user
wrote is lost), parks it for that controller's life and logs it as an error. A restart earns one more
attempt per entry, a sign-in builds a new controller. A 5xx still climbs the backoff ladder. Tests:
`auth.test.ts`, `tokenIdentity.svelte.test.ts`, `mlsDeliveryApi.forbidden.test.ts`,
`outbox.test.ts`. HOW the split is produced is open: [backlog](backlog.md).

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

## The native refresh credential could live in the platform keychain, on both platforms (2026-08-27)

Not a defect, a strict improvement deliberately not bundled with the fix that needed shipping; the open line is in [backlog](backlog.md). Today the credential sits in a file inside the app sandbox - the Chromium cookie file on Android, a `@tauri-apps/plugin-store` file on `tauri://localhost` (see the credential section above). Both are protected by the OS at the container level and neither is encrypted as a secret. iOS Keychain and Android Keystore / `EncryptedSharedPreferences` are better, and the same argument applies to each.

**What blocks it from being trivial**: `patches/tauri-plugin-keystore` already reaches the iOS keychain, but builds `SecAccessControlCreateWithFlags` with BIOMETRIC flags because it guards the MLS device key - reading it raises Face ID, which cannot sit in front of every cold start. It needs a second, non-biometric command in the vendored plugin (`kSecAttrAccessibleAfterFirstUnlock`), Kotlin parity so the Android build still links, a permission entry and an iOS build to verify - none of it measurable from a workstation. **Do not start it as a security fix**: the current posture is the one Android has always had and the user has accepted; do it when native work is happening anyway.

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
- **An upload that meets a 401 refreshes and retries ONCE; it never ends the session.** The media
  upload takes a token its caller read BEFORE a long encryption, so a 401 is usually a stale copy.
  `fetchUpload` in `frontend/src/lib/media.ts` (every `MediaService` upload route) obeys the one rule
  below. Prod 2026-10-06: 9 `POST /api/media/upload` 401 in 30 h from a web client, each followed by
  logout and sign-in. The salon branch's stale `ctx.authToken` copy (#1472) and the post forms (#1477)
  fixed WHO hands the token; this fixes the token expiring between the hand-over and the request, for
  every caller including reels and avatars. Test: `media.uploadRefreshRetry.test.ts`.

## A 401 renews the token and sends the same request once - one rule, every caller

ONE implementation, `frontend/src/lib/utils/renewOn401.ts`. On a 401 to a request that carried a
bearer: use the token in memory if another caller already renewed it (the single flight only joins a
refresh while it is PENDING), else renew through `refresh()`; send the SAME request once more; release
each unread 401 body (`plugin-http` holds the connection until then). The renewal is BOUNDED by the
request it serves - it is raced against the caller's signal, so a deadline (`trackedFetch`) ends the
request at the deadline, as a `RequestDeadlineError`, while a renewal error that settles in time
reaches the caller as itself. What the renewal threw is rethrown as it came - a dead cookie
(`SessionExpiredError`), a refresh answered 5xx (`RefreshFailedError`), a refresh that reached nobody
(a transport failure, never a logout) - unless the caller types it (`renewalFailed`): the MLS delivery
API turns the two that say only "no new token now" (`RefreshFailedError`, a transport failure) into
`DeliveryRenewalFailedError`, a 401 refusal, because the server DID answer and the request did nothing.
Read as "no answer", a commit used to be resubmitted into the same 401 and kept as unknown.

Two more guards, both decided on durable state, never a clock:
- **A renewed token the guard refused is never renewed again** (`RefusedRenewedToken`, the latest one
  latched per delivery API, replaced by any other token). A later 401 on that same token answers
  `DeliveryRefusedRenewedTokenError` at once: a guard refusing every renewed token would otherwise rotate
  the session once per request.
- **A request is never resent as another account.** When the refused token and the one to resend with
  both decode to a `sub` and the two differ (a sign-in to another account landed in between), the
  request is not sent again: `TokenAccountChangedError`, typed, not a logout.

**What a 401 on the RENEWED token means is the caller's to say, because it depends on whose guard
answered.** `apiFetch` and the media upload answer `SessionExpiredError`: core's guard IS the session
authority. The MLS delivery API answers `DeliveryRefusedRenewedTokenError` (an `ApiRefusalError`, status
401) - a failed request, NEVER a logout. `refresh()` has just proven the session alive, and the delivery
guard also answers 401 for its own faults (an internal shared secret unset, an internal signature
refused). A logout there would have reached the login's catch (`sessionAuth.ts`, which forgets the user
and clears the restore key on `SessionExpiredError`) through the unguarded delivery steps of
`syncConnectionAfterWsOpen` - the KeyPackage publication itself catches its failure.

**The premise that makes the resend safe is a fact of today's servers, not of HTTP.** On `/api/mls/*`
every 401 comes from the guard, before any handler. Social-service also answers 401 from INSIDE
handlers (authorization refusals in its posts routes), where a resend is useless rather than unsafe; a
handler-level 401 added under `/api/mls` would turn a commit's resend into a second submission (the gate
would still answer it `duplicate`). Both server-side corrections are a P3 in
[backlog](backlog.md#p3---a-guard-answers-5xx-for-its-own-faults-and-an-authorization-refusal-is-a-403-review-of-2420-2026-10-25).

`MlsDeliveryApi` builds its own headers on an injected `fetch` (Tauri passes `plugin-http`) and takes
the rule as a `fetch` decorator, `renewingOn401`, applied once in its constructor
(`productionDeliveryApi`, the one construction that ships, pinned by its test). It covers every route
of that class through the injected `fetch`, except the pending pull, which applies the rule itself
(`resendAfter401`) OUTSIDE its page-halving ladder: a slow renewal is not a silent page, and a failed
one is thrown as itself rather than halved. Outside the rule: the delivery keepalive POST
(`deliveryKeepalivePost`, `null` on any failure) and the ACK queue (`ackMessagesWithRetry`, its own
ladder); and every request that still sends a raw bearer without either wrapper -
`ChatBackgroundService`, the fetches of `sessionAuth.ts`, `PushNotificationService`, `mediaBlobCache`,
`segmentedMediaReader`, `mediaTouch`, and the direct fetches of the associations and forms modules.

The MLS delivery API had no rule until 2026-10-25: a commit answered 401 ended an Add with the group at
its old epoch (TOK-1; what the commit gate makes of each outcome is in
[mls-protocol](protocols/mls-protocol.md)). Tests: `renewOn401.test.ts`,
`mlsDeliveryApi.renewOn401.test.ts`, `productionDeliveryApi.test.ts`, `apiFetch.test.ts`.
