# Auth module

**Routes**: `src/routes/login/`, `src/routes/auth/callback/`  
**Components**: `src/lib/components/auth/`  
**Store**: `src/lib/stores/auth.svelte.ts`

## Responsibilities

- OIDC login via Authentik (redirect flow with PKCE).
- Access token management (in-memory only).
- Refresh token rotation via HttpOnly cookie.
- WebSocket auth cookie (`canari_ws_token`) synchronization.
- PIN setup and verification (used to encrypt MLS state).

## Login flow

```
/login -> startOidcLogin()
  -> redirect to Authentik /authorize (PKCE S256 + state)
  -> callback to /auth/callback?code=...&state=...
  -> POST /api/auth/oidc/callback { code, redirect_uri, code_verifier }
  -> store access_token in memory
  -> set canari_ws_token cookie
  -> redirect to /chat
```

**PKCE (RFC 7636, S256).** `startOidcLogin` keeps a verifier beside the state (`$lib/utils/pkce`),
sends its hash as the challenge, and the callback hands the verifier to core-service with the code;
MiConnect checks the pair at its token endpoint. A code captured on its way back is then refused
without the verifier, which the client secret cannot ensure, since core-service is the party holding
that secret. What authentik refuses is measured by `infrastructure/authentik/test-pkce.py`
([authentik](../../infrastructure/authentik.md)).

- **Sent only to a server that can redeem it.** The challenge goes out only when the last
  `/api/version` answer carried `oidcPkce: true` (`getAppVersionCheck()`, refreshed by the login
  preamble just before). A core-service older than that field drops the verifier, and MiConnect
  refuses a challenged code redeemed without one, so a challenge sent to it would make the sign-in
  fail. This is a CAPABILITY read before the request, not a fallback: no failed attempt sits behind
  it, and a new client facing an older server simply signs in without PKCE, as before. A verifier
  left by a sign-in that never returned is removed when no challenge is sent, since MiConnect also
  refuses a verifier for an unchallenged code.
- **Ship order.** The server half ships first, and core-service is never rolled back below the
  release that publishes `oidcPkce`; the condition that later makes PKCE required lives in
  [legacy-compatibility](../../legacy-compatibility.md).
- **Where the verifier lives.** On the web, `sessionStorage`: the redirect to MiConnect and back stays
  in one tab, and the secret dies with it rather than staying readable by every tab of the origin. In
  the apps, the `oidc-state.json` plugin store, with the state, because the WebView's navigation can
  clear web storage. It is read once and removed by the callback.
- **A callback in another browsing context fails on the client, by name.** On the web the state is in
  `localStorage` and the verifier in `sessionStorage`, so a callback that lands in a context other
  than the one that started the sign-in (a link reopened in a new tab, an installed PWA handing off
  to the browser, a closed tab) passes the state check and finds no verifier. Posting that challenged
  code would only buy MiConnect's refusal, where sign-in used to work. So `startOidcLogin` also writes
  `canari_oidc_challenged` WITH the state (it holds no secret), and a callback that finds the mark
  and no verifier throws `OidcSignInError('verifier-lost')` without posting; the callback page shows
  its localized message (`auth_oidc_verifier_lost`) on `instanceof`. core-service's typed refusals
  `OIDC_PKCE_REFUSED` / `OIDC_CODE_REFUSED` become `OidcSignInError('code-refused')` the same way.
  **Rejected: both in `localStorage`.** That would make the cross-context callback succeed, but it
  leaves a bearer secret readable by every tab of the origin and by anything that reads persisted
  storage, for as long as an abandoned sign-in leaves it there - exactly what the verifier must not
  be. Both in `sessionStorage` is rejected too: the state would then be lost in the same contexts,
  failing with a CSRF-shaped error rather than a named one. The cost accepted: a sign-in started in
  one context and finished in another must be started again, and it says so.
- **What it does not close.** PKCE binds a code to a verifier, not to an app: on a phone the redirect
  is the `fr.emse.canari://callback` custom scheme, which the OS does not verify. That is the next
  step, an `https` callback on a claimed host (in the backlog).
- **No `nonce`.** The authorize request carries none, and nothing checks one: the id_token is
  fetched by core-service straight from the token endpoint over TLS, bound to the code (and now to
  the verifier), never received through the browser, so the replay a `nonce` guards against has no
  path here. The client keeps that id_token only as the sign-out's `id_token_hint`.

### The press is not the first thing that happens, and the button must say so

`handleLogin` does not go straight to `startOidcLogin`. It first awaits
`refreshAppVersionCheck()`, because a client below `minClientVersion` must be refused here rather
than after a round trip to Authentik. That check calls `GET /api/version` and carries its own
retry ladder - three 8 s timeouts plus backoff, ~26 s in the worst case - and it swallows every
failure, answering from cached metadata instead.

So the button's busy flag is raised BEFORE that await, not after it, and lowered again only on the
refusal path. Until 2026-08-30 the order was the other way round: the whole ladder ran with the
button enabled, no spinner, and no visible effect, and a press on a degraded connection looked
ignored. The disabled state and the spinner were already there in `LoginForm` - `disabled={isLoggingIn
|| loginDisabled}` and a `{#if isLoggingIn}` spinner - so nothing was missing except the moment they
were switched on. **A busy flag raised after an await leaves the await itself unguarded**, and the
await is the only part slow enough for anyone to notice.

The preamble is `beginLoginAttempt()`, shared by the OIDC button and the password form, and it
returns whether the caller may proceed. The two handlers had duplicated it, which is how one of them
drifted: `handleLogin` called the async `startOidcLogin(...)` without awaiting it, inside a `try` /
`catch` that therefore caught nothing - a rejection there showed no error and left the form busy for
ever. Both await it now, and both report through `failLoginAttempt()`.

**The window is not a hydration gap.** `+layout.ts` sets `export const ssr = false` and `/login` is
not prerendered, so the button does not exist in HTML before JS runs: it is painted by the same
bundle that wires its handler, and there is no interval in which it is visible but dead.

### The order of the startup phases, and why the socket is now first

`startSession` names its own spans - `beginStartupCatchupPhase(...)` in
`session/sessionAuth.ts`, read back by `catchupBenchmark` - and that list IS the startup, in order:

| Phase | What it does |
|---|---|
| `setup_handler` | registers the inbound pipeline, so nothing can arrive unhandled |
| `open_gateway` | `openGatewayConnection` ADOPTS a socket that has been opening since before `setup_handler` |
| `load_conversations` | the archive replay out of the local store, one conversation at a time |
| `fcm_cache` | merges what a background notification decrypted while the app was dead |
| `initialize_connection` | `syncConnectionAfterWsOpen` - KeyPackages, the group sweep, reconciliation |

**Until 2026-09-15 `open_gateway` did not exist, and the socket opened in the LAST phase.** The
user's production console shows `Initialised in WEB mode` at 22:24:17 and `[TAB] Leadership acquired
(Web Locks)` at 22:24:39: twenty-two seconds - the whole replay - with no socket. Two things follow,
and only the first is obvious.

Nothing live could arrive for twenty-two seconds. And **every mailbox barrier re-pulled the whole
mailbox.** `settleBarrier` (`BaseMlsService.ts`) may trust a previous pull only while
`mailboxEmptiedByAPull && this.isWsOpen()`, and that second conjunct is correct, not the bug: with
no socket the server can have queued a row since the pull and nothing would have pushed it. So with
the socket closed the flag is worth nothing, and twenty conversations meant twenty HTTP round trips
each answering `[PENDING] No pending MLS messages`.

**Only the socket moved.** `openGatewayConnection` and `syncConnectionAfterWsOpen` were already two
functions (`$lib/utils/chat/connection`) precisely because they answer to different preconditions:
the first needs the inbound pipeline registered, which `setup_handler` has just finished; the second
reasons about the conversations this device holds and must not run before they are loaded. Moving
the pair would have had the group sweep reconcile against an empty map.

**Opening the socket adds no concurrency the replay did not already have.** The barrier pulls frames
and processes them during the restore today; what changes is that the barrier can now believe its
own result. The offline branch skips `open_gateway` entirely rather than letting it fail - the
attempt costs a timeout on a launch that already knows there is no network.

### And since 2026-09-16 the handshake starts before the phases do

The table above is where the socket is AWAITED. It is no longer where the socket is OPENED.

Measured on production 2026-09-16, between `MLS ready` (+1093 ms) and `[WS] Connected to Chat
Gateway` (+1308): the serial work between the two is 33 ms and the handshake is 182. It was queued
behind `load_or_create` and reads nothing that function produces - `connect` sends a device id and a
token, and `resolveDeviceId` answers both before `init()` is called. So `startGatewayHandshake` now
fires there, tab leadership moved up with it (it is what decides whether to open a socket at all),
and `open_gateway` adopts the result. **A small `open_gateway` span is therefore the handshake
WINNING, not the handshake being fast**, and the benchmark must not be read the other way.

**WHAT PAYS FOR THAT CONCURRENCY IS A QUEUE, AND IT IS THE WHOLE COST.** A socket open before the
MLS client exists can be handed a payload frame with nowhere to go, and the gateway's delivery
accounting does not distinguish "handed to a client" from "handled by one" - so the loss would be
silent on both ends. `BaseMlsService` holds every inbound frame in arrival order until the login
calls `markInboundReady()`, then replays them sequentially, because a Welcome and the Commit behind
it admit exactly one order. Heartbeats never reach the gate; everything else waits, payload frames
and control frames alike, because a control frame whose callback is not yet registered is dropped
just as silently as a payload one. A session that ends with frames still held SAYS so.

The gate lives on the base class, so both sockets pass it, and the per-frame routing was extracted
to `routeFrame` on each platform so that a held frame and a live one take literally the same path.
Behaviour is in `BaseMlsService.inboundGate.test.ts` and `startGatewayHandshake.test.ts`; the boot
ORDER, which no behavioural test can see, is in six source guards in `offlineUnlock.test.ts`.

#### The device id is not final when the handshake starts (fixed 2026-10-25)

The paragraph above said the socket "reads nothing" the state load produces. **That was wrong for one
fact: the device id.** `init()` can ROTATE it (`reenrolLostState` for a kept id whose state is
provably gone, a credential that names another device), and the gateway routes by the `device_id` in
the socket URL. Reproduced on a web pre-release after a lost-state re-enrolment: the socket opened
under the abandoned id about a second after the new one was minted, presence listed only the old id,
the new id got its frames by queue and push only until the next reconnect, and the retirement of the
old id signalled `device_revoked` to that same live socket (`gatewaySubscribers=1`). That frame did
no damage - the handler asks the server about the CURRENT id, which is not revoked, and ignores it -
but the socket was deaf to the device it belonged to.

**The fix is at the rotation, one implementation for web and Tauri (`BaseMlsService`):**

- `connect` is concrete on the base class and QUEUES every open. The platform half is
  `openGatewaySocket(open)`, handed the id recorded for that socket and the token its caller
  fetched, so the web open has no await before `new WebSocket` and a refused refresh is the
  caller's `SessionExpiredError`, never an unauthenticated open. Two opens in flight together used
  to let the first one's 15 s deadline close the second socket.
- `rotateDeviceIdentity`, once the new id is on disk, queues a reopen: behind any open in flight,
  and it replaces the socket only if one is open under another id - re-read after the reopen's own
  token fetch - sending `disconnect` on the old one first, as a pause does. Without a socket it
  opens nothing; the next open reads the new id.
- **A pause FENCES the queue.** `pauseSocket` (backgrounding, a sign-out releasing a login) moves a
  generation. Every caller of `connect` reads it (`socketFence()`) BEFORE its token fetch - the
  await a backgrounded phone parks a reconnect in - and `connect` refuses a fence a pause has
  passed. Every queued step and platform open re-reads it after each await (the token fetch, the
  release of the previous native socket, the native connect) and touches no shared field once it
  is stale; the native open lets go of the previous socket's fields BEFORE its await, never after,
  so a late open cannot clobber a later one. An open still CONNECTING is settled at once as
  `GatewayOpenAbandonedError` through a kept handle, so the queue never waits on the 15 s deadline.
- `openGatewayConnection` reads that error as no failure: it logs no error and schedules nothing
  itself. On the reconnect path the ladder's own retry is then refused by the pause flag, with its
  line (`scheduleReconnectImpl`); the resume opens the next socket.
- `openGatewayConnection` waits for `gatewaySocketSettled()` before the post-connect half, so the
  pending fetch and the KeyPackage round run on the socket that will carry this device. A failed
  reopen fails the connection like any open. On the login path, which has no ladder and whose
  disconnect handler is registered only after the settle, the reconnect is scheduled there and
  then; a reopen failing after the session is up is reported on the disconnect seam.
- The revoked-KeyPackage round waits for the reopen before it republishes - the publication is
  what makes the new id addressable - and then reads the new id's pending queue once.
- An abandoned id is deleted only once no socket of this document carries it
  (`deleteAbandonedDevice`); otherwise it stays recorded for the next published round, in one line.
- A login stopped by a sign-out releases its socket after the queued reopen too, not at the
  handshake.

**The overlap is kept.** A login that does not rotate pays nothing; one that rotates pays a second
handshake. Behaviour is in `BaseMlsService.socketRotation.test.ts`,
`TauriMlsService.socketRotation.test.ts`, `startGatewayHandshake.test.ts` and
`signOutDuringLogin.test.ts`.

#### A destroyed client keeps no socket, and none lands on it later (2026-10-25)

**The overlap opens the socket BEFORE the login knows it will succeed.** On the PIN path the server
has accepted the PIN by then; on the unattended paths (biometric, vault, hardware-held "stay signed
in") nothing has proved the key yet - the keystore read is inside `init`. That is on purpose (the
measured 182 ms above), and it makes one more thing owed: **a login that fails releases the socket it
opened.** It goes through `resetMls`, which destroys the client it built.

What the code did, certain from reading it:

- `destroy` did not FENCE the socket queue. A handshake still in its token fetch or its native
  connect when the login failed (a fast failure: an empty keystore, a refused vault) landed AFTER
  the destroy, assigned its socket to the destroyed client and started its heartbeat.
- On the web, `destroy` did not close the socket at all, open or opening.
- Nothing held that client any more. A pause, a reconnect and a sign-out all act on the CURRENT
  client (`ensureMls()`), and a sign-out at the PIN gate has no session and no login in flight to
  stop - so no path could ever reach the socket.
- The socket stays alive by itself: the plugin's Rust reader (or the browser) answers the gateway's
  protocol pings with no JS involved, and the gateway refreshes `user:online:{user}:{device}` on
  every pong. Dropping a JS handle releases nothing; only a `Close` does.

**The fix is the destroy.** It now runs the pause (the fence moves, an open in flight is settled as
abandoned at once and releases whatever socket it later receives, `disconnect` is sent so the
presence goes immediately) and marks the client retired: a `connect` on a destroyed client opens
nothing and accuses its caller at `error`, because its fence can only match if it was taken after the
destroy. Tests: `TauriMlsService.destroyFence.test.ts`, `WebMlsService.destroyFence.test.ts`.

**The gateway's rule for a second socket of one device is to ADD it** (the comment at the
registration in `apps/chat-gateway/src/handlers.rs`): sibling tabs, a reconnect overlapping its
predecessor's close and a deploy overlap are all legitimate, and a sibling may sit on another
process. So the gateway cannot tell a forgotten socket from a sibling, and releasing every socket it
opened is the client's job - which is why the fix is here.

**Owed, on an iPhone (TestFlight, server side only so far):** the reading that showed two sockets of
one device at the PIN gate, both alive after a sign-out, fits this class but the app's own log was not
read. To close it: on the build carrying this fix, reproduce (stay at the PIN gate after a failed
unattended unlock, then sign out) and read in the app log `[INIT] Login did not complete (...)`
(or `Login failed`) followed by `[WS] MLS client destroyed` and NO later `[WS] Connected to Chat Gateway`; on the gateway,
one `Explicit disconnect` (or a close) per socket opened and no presence refresh for the device after
the sign-out. A second socket that appears WITHOUT a failed login between the two is a different
cause, and this fix does not claim it.

The order is asserted by `session/startupOrder.test.ts`, deliberately a SOURCE test: the property is
an order between two statements inside a function that takes a live MLS client, a storage backend, a
device key and a gateway, so there is no seam to observe it through short of running a whole
session. A crude test that can fail is worth more than an elegant one that does not exist.

### What happens BEFORE those phases, and the bench that reads it

`catchupBenchmark` begins on the line immediately before `[INIT] MLS ready`, so the phases above are
everything AFTER that point. Everything before it - the whole of `loginImpl` - had no clock at all
until 2026-09-17, and on the user's own export it was the most expensive block of the boot.
`mls-client/bootBenchmark.ts` covers it, and the two abut on one line with no gap and no overlap:
`finishBootBench()` is called immediately before `beginStartupCatchupBench()`.

**IT IS A SECOND MODULE RATHER THAN A THIRD `kind` ON THE FIRST, for three reasons that are each the
inverse of the catch-up bench's:**

| | `catchupBenchmark` | `bootBenchmark` |
| --- | --- | --- |
| unit | durations, from `Date.now()` | **offsets from `performance.timeOrigin`** |
| concurrency | one active phase; a new one closes the last | **named spans that may OVERLAP** |
| counters | messages, conversations, acks | none - none is evidence for this question |

The offsets are the point: anchored to the navigation, a bench line and a HAR line are the same
number, and the report carries the document's `PerformanceNavigationTiming` too, so it answers
without a HAR at all. The overlap is not an artifact either - the gateway handshake starts ~200 ms
before it is awaited and the revocation answer is held across the local decrypt, two concurrencies
this module reports rather than flattens.

**IT RECORDS ON EVERY BOOT AND LOGS ONLY WHEN ASKED.** A flag needing a reload cannot capture a cold
start: by the time anyone wants the measurement, that boot is over. `window.__canariBootBench.get()`
answers on any build with no flag and no reload; `localStorage.setItem('canari_boot_bench', '1')`
only adds one summary line per boot on top. `.summary()` prints TWO totals - from navigation and from
`login-start` - because `loginImpl` also runs when someone types a PIN into a tab open for half an
hour, and guessing a threshold past which a boot "is not really one" would be a clock deciding the
meaning of its own measurement.

**THE SPANS, AND WHERE EACH IS DECLARED.** `sessionAuth.ts` owns the login sequence; the two MLS
services own what is inside `init`, under the SAME NAME on both platforms so an Android reading and a
browser reading can be set beside each other:

| span | where | note |
| --- | --- | --- |
| `access-token`, `pin-salt-fetch`, `pin-verifier-pbkdf2`, `resolve-device-id`, `pin-check-request`, `device-key-pbkdf2` | `sessionAuth.ts` | the PIN branch; a returning session skips all of it |
| `tab-leadership`, `revocation-gate`, `auth-token-final` | `sessionAuth.ts` | each carries `meta` saying which way it went |
| `mls-init-and-storage` | `sessionAuth.ts` | the `allSettled` PAIR - its wall time |
| `mls-init`, `storage-open` | `sessionAuth.ts` | the two concurrent halves of that pair |
| `mls-load-state` | `TauriMlsService`, `WebMlsService` | the decrypt; `meta.recovered` says whether it fell into recovery |
| `mls-save-state`, `mls-list-groups` | `TauriMlsService` | the first is NOT awaited, the second IS |

`timeBootSpan(name, promise)` wraps a promise instead of bracketing an `await`, which is what lets
the unawaited snapshot write be measured without being awaited: a span still open at `MLS ready`
keeps `endMs: null` and is omitted from the ranked summary, because a write that outlived the boot
did not cost the boot its whole duration and reporting one would be a number nobody waited for.

**`bootBenchmark.test.ts` asserts SHAPE AND NEVER A WALL CLOCK** - which spans exist, which stay
open, what the summary ranks and omits, and that a report already read cannot be rewritten by a span
closing afterwards.

## Routes

| Route | Description |
|---|---|
| `/login` | Login page (OIDC button + optional dev form) |
| `/auth/callback` | Receives OIDC auth code, completes login |

**A phone-sized WEB visitor is offered the store badges.** `LoginPage` gates them on
`isTauriRuntime()` being false (a native install already IS the app) and `isPhoneViewport()`
(`PHONE_VIEWPORT_QUERY` in `frontend/src/lib/utils/viewport.ts`, width alone against Tailwind
`md` - no `pointer: coarse`, so a touch laptop with a narrow window is not read as a phone).
`LoginForm` links `PLAY_STORE_URL` / `APP_STORE_URL` (`appVersion.ts`, the same constants the
in-app update prompt already uses) as plain anchors rather than through `openExternal()` - they
are first-party constants, not attacker-reachable content, so the Safe Browsing round trip
(`checkLinkSafety.ts`) would only add an unauthenticated 401 to the log for every visitor on the
login page.

Each anchor wraps the OFFICIAL badge artwork, fetched from Apple's and Google's own brand pages
rather than redrawn by hand, and in FRENCH since 2026-10-01 (the English "Download on the App
Store" / "GET IT ON Google Play" were flagged by the 2026-09-25 login audit, both stores publishing
French ones): `frontend/static/app-store-badge.svg` (Apple's marketing toolbox, `fr-fr`, "Télécharger
dans l'App Store") and `google-play-badge.png` (play.google.com, `fr_badge_web_generic.png`,
"DISPONIBLE SUR Google Play"). Google's PNG ships transparent margin that Apple's SVG does not
(29px above and below on the French one); it is cropped to its real content so both badges share
one visual height side by side (`h-10` on both `<img>` tags).

### Open in the app, from the login page (2026-10-08)

The 2026-09-25 audit also found no "Ouvrir dans l'application" on `/login`. `LoginPage` now computes
`loginOpenInAppOffer` (`lib/mobile/openInApp.ts`) beside the badges, so it shows only on a
phone-sized web visit, never in the native app. `/login` is not a path the app claims, so the
target is the page behind `returnTo` when claimed, else `/chat` (the app's home, which asks for a
sign-in itself). Android: the `intent://` URL on the https App Link filter (Play listing as
fallback); iOS: `fr.emse.canari://open?url=...` (nothing happens without the app - the badges sit
right below). Hosts outside `MOBILE_APP_LINK_HOSTS` (dev) get no link. Same builder as the in-app
browser banner ([mobile](../mobile.md#leaving-an-in-app-browser-for-the-app)). The English-badge
half of that audit entry had already shipped on 2026-10-01 (above). **Owed: one tap on each phone
with the app installed** - measured only as the rendered link in a headless Chrome with an Android
user agent (local host temporarily whitelisted), never followed into the app.

**The card is FLAT** (same audit, checklist line 1 of
[ecosystem-convergence §12](../../ecosystem-convergence.md#12-the-interface-bar---one-checklist-for-every-site-each-rule-tied-to-a-measurement-2026-09-25)):
the sign-in button's yellow glow, the logo tile's 32px shadow, the card's `shadow-2xl` and the
drop-shadows on the logo and title are gone; `LoginForm.flat.test.ts` fails on any shadow utility in
the markup. "Connexion externe (service-account)" stays word for word (user, 2026-09-25).

## Auth store

```typescript
// auth.svelte.ts
export const currentUser: Writable<User | null>;
export const accessToken: Writable<string | null>;

export function setWsSessionCookie(token: string): void;
export function clearWsSessionCookie(): void;
export async function refreshAccessToken(): Promise<string | null>;
export async function logout(): Promise<void>;
```

`apiFetch.ts` intercepts 401 responses: it calls `refresh()` once and retries. It clears nothing and
redirects nowhere - it THROWS, and the logout paths (`ChatBackgroundService`, `sessionConnection`,
`promoteOfflineSession`) decide from the type of what it threw.

### A status parsed back out of a sentence is a status that was discarded

`+layout.ts` logged a user out on `String(error).includes('(404)')` - matching a number
`fetchUserProfile` had formatted into its own message a moment earlier. The status is the ANSWER;
carry it as a field (`UserProfileFetchError.status` in `stores/user.ts`) rather than printing it and
reading it back. Only a 401 or a 403 may end a session, so the branch that needs the status is
exactly the branch that must not guess it.

Corollary for any audit of a seam like this: **one surface handling a case is not "the case is
handled"**. Enumerate the CONSUMERS of the seam, never just the ones whose source mentions it.

#### And the classification survives only as far as the next `catch`

The same defect arrived a second time (2026-09-15) from the opposite direction: nobody had thrown
the status away at the throw, `_doRefresh` separates its three outcomes with some care, and
`apiFetch` destroyed all of it ONE FRAME LATER with `catch { throw new Error('Session expirée -
veuillez vous reconnecter.') }`. Downstream, `useChannelWorkspaces` then rebuilt a status by
searching the sentence for any three-digit number and decided retryability from a list of words -
`fetch`, `network`, `timeout`, `abort`. So a 502 during a deploy read as a dead session, and a
refusal whose text happened to mention a network was retried three times against a server that had
already decided.

**A `catch` that rethrows something else is a classification site, whether or not it was meant to
be one.** Rethrow what you caught unless you are ADDING information; the three refusals now leave
`apiFetch` as `SessionExpiredError` (the cookie is dead), `RefreshFailedError` (the server answered
something that is not a verdict on the session - transient by construction, since 401 and 403 leave
as the sibling) and the transport failure as itself.

**And then ONE predicate, not two.** "Worth retrying" and "call it a network error in the toast" are
the same question - the server did not decide anything - and they were two hand-written lists that
agreed only while someone kept them agreeing. `isRetryableLoadError` answers it once, from
`ChannelApiError.status`, and the toast reads that answer.

### Signing out ends the MiConnect session (2026-10-14)

**User decision**, after the Mi 9T could not reach the user's own account: the sign-out revoked
Canari's session and left MiConnect's cookie alive, so the next "Se connecter" came back silently as
the account that had just left. Every sign-out somebody CHOSE is now `clearAuth()` then
`leaveSignedOut()` (`stores/auth.ts`): the navbar, the dashboard, the PIN gate's "Se deconnecter",
the maintenance gate, the identity-split notice and the account deletion. A DEAD session
(`handleSessionExpired`) and a revoked device still go straight to `/login`: nobody chose to leave
MiConnect there, and its cookie is what makes the next sign-in one tap.

`leaveSignedOut` takes the id_token `handleOidcCallback` kept (OIDC store: `localStorage` on the web,
the Tauri store in the apps; one use, removed whatever happens), and `planMiconnectSignOut` decides
from facts already known:

| Platform | What happens | Comes back on |
| --- | --- | --- |
| web, desktop | the document goes to `<issuer>end-session/?id_token_hint=...&post_logout_redirect_uri=...` | `<origin>/login` |
| Android, iOS | the same URL in the in-app browser the sign-in used (Custom Tab / `ASWebAuthenticationSession`, which share the browser's cookie jar where the MiConnect cookie lives); the app goes to `/login` meanwhile | `fr.emse.canari://signed-out`, which closes the browser (iOS: the session completes on its scheme; Android: the `singleTask` activity comes back over the tab) and logs `[AUTH] MiConnect session ended` |
| known offline, no id_token, issuer on another origin than `VITE_AUTHENTIK_URL` | MiConnect is not asked; the Canari sign-out is complete | `/login`, with a `warn`: `MiConnect session NOT ended (<reason>)` |

The endpoint is the id_token's `iss` + `end-session/`, so each estate names its own provider with no
build variable. **MiConnect never holds the Canari sign-out hostage**: `clearAuth` has already
revoked the session when MiConnect is asked. What stays unobservable from the client: a device that
believes it is online and is not (the web lands on the browser's error page, the phone on the tab's;
the sign-out is already done underneath), and an iOS user who cancels the system sheet (the plugin
reports nothing past `start()`). A sign-in that predates the id_token (any session opened before
this release) has none, so its first sign-out is `local-only` and says so.

The "Rester connecte" vault, `mls.bin` and the message database are untouched, as before. The
provider half (flow, `logout` redirect URIs) and why authentik needs the hint are on
[authentik](../../infrastructure/authentik.md#signing-out-of-canari-ends-the-miconnect-session-2026-10-14).
Tests: `stores/auth.miconnectSignOut.test.ts`, `mobile/oidcSignOutRegistration.test.ts`,
`mobile/deepLinkHostsDeclared.test.ts`.

## PIN and device key

The PIN itself never encrypts anything and never leaves the device. It is the input to two
domain-separated PBKDF2-SHA256 derivations over the same server-issued salt:

| Derivation | Where | Iterations | Used for |
|---|---|---|---|
| `computePinVerifier` | `crypto/pinVerifier.ts` | 100 000 | Sent to `POST /api/mls/security/pin-check`; detects a PIN changed on another device |
| `deriveDeviceKeyB64` | `crypto/deviceKey.ts` | 310 000 | 32-byte at-rest key (`deviceKeyB64`) - the only thing that decrypts `mls.bin` and local messages. **Web and desktop only since 2026-10-22**: a phone's key is random and hardware-held ([below](#the-at-rest-key-on-a-phone-is-held-by-the-hardware-2026-10-22)) |

`deviceKeyB64` is the single at-rest key: `mls.bin` is ChaCha20-Poly1305 (`[nonce 12 || ct]`),
local messages, Graine seeds and outbox payloads are AES-256-GCM (`[iv 12 || ct]`). Rotating the
PIN re-derives the key and re-seals all of them (`utils/chat/pinChange.ts`) - every store is in
[the table below](#what-the-device-key-seals-and-what-a-pin-change-does-with-each).

**PIN policy** (`utils/chat/pinValidation.ts`): at least 4 characters, no upper bound and no
character-set restriction, checked by the single `isValidPin` on every path (first setup, PIN
change, recovery, unlock). The rule is deliberately uniform: the device key derives from the
exact string typed, so any check a PIN could pass at creation but fail at unlock would lock its
owner out of their own messages.

### A prompt is declined from a FACT, never from a refusal

`_refreshCredentialProvenDead` latches the moment the server proves the refresh credential dead, and
`isRefreshCredentialProvenDead()` exports it. It exists to be read by callers that decide something
BEFORE asking - the encryption-PIN keypad above all, which used to be mounted on a client already
known to be finished: the user typed a correct PIN, the modal closed a second later, and the login
gate appeared underneath (measured on W1, 2026-08-28).

Read it only to SKIP work. It is not a logout trigger - the logout is announced once, from
`setSessionExpiredHandler`, at the moment the latch is set - and reacting to it a second time here
would be a second answer to a settled question.

**There were four decision sites, not one.** `mayPromptForPin()` is the shared gate, and it is named
for the question rather than for either of the two independent facts that answer it: the platform
gates (minimum version, maintenance) refuse an unlock the SERVER would not honour, and the latch
refuses one the CLIENT could not use. Three sites go through it. `onSavedPinFailed` did not - a
login that failed because the session is over arrives there like any other rejection - so it checks
the latch directly, which is synchronous and needs no await.

One site is deliberately ungated, and the code says why: the keypad shown after a successful
server-side PIN reset. That POST carried a live access token, and the local MLS state is already
wiped, so declining there would leave the user mid-reset with nothing to unlock and no way to
finish.

### Where the key lives

| Storage | Written by | Purpose |
|---|---|---|
| Device key vault (`utils/deviceKeyVault.ts`) | PIN login | AES-GCM-wrapped key, ONE SLOT PER ACCOUNT (`canari_device_key_vault:v2:<userId>`, the account also bound as the AEAD additional data), in `sessionStorage`, or `localStorage` when "stay signed in" is on (`canari_device_key_persist`). See [the vault names its account](#the-vault-names-its-account---fixed-2026-10-14) |
| Platform keystore, alias `mls_device_key_{userId}_{deviceId}` | `store_push_context` (Tauri) | Biometric unlock **and** background FCM/NSE decryption - the only at-rest copy on a device |
| `push_context.json` | `store_push_context` (Tauri) | `userId`, `deviceId`, `baseUrl`, `pushToken` only. Since WP-SEC-1 it carries **no key material** |

"Stay signed in" moves the **device key** across a restart, never the PIN - the PIN has not been
persisted anywhere since v0.11.0. The user-facing copy (`auth_pin_stay_signed_in_desc`,
`profile_stay_signed_in_desc`) must say so: describing the wrong secret on a security control is a
defect in the control.

Enrolling biometrics wipes the vault (`clearDeviceKeyAndWrapKey`, every account's slot) and turns
"stay signed in" off, so the next launch goes through the keystore. A PIN change must **not** delete the keystore entry:
`IMlsService.changeDeviceKey` has already overwritten it with the new key.

**The background copy is a second keystore entry, not a second file.** A push handler runs with no
user present, so it cannot satisfy a biometric gate - but it still needs the device key. Each
platform therefore keeps one entry that is hardware-backed yet usable unattended:

| Platform | Entry | Why it is readable in the background |
|---|---|---|
| Android | same alias, `setUserAuthenticationRequired(false)` | Read without an Activity by `MlsDeviceKeyStore` (Context-only). **Never** `setUnlockedDeviceRequired(true)` - that makes the key unusable while the screen is locked, which is exactly when a push arrives |
| iOS | second item, account `mls_bg_key_<alias>` | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and **no** `kSecAttrAccessControl`; shared with the NSE through access group `group.fr.emse.canari` |

Enabling biometrics changes the unlock *method*, never where this copy lives. Installs predating
WP-SEC-1 (2026-07-28) held the key in `push_context.json`, promoted to the keystore by a one-shot
native migration at the next start. **Both migrations were deleted on 2026-10-22**: they wrote the
keystore entry with no at-rest guard (below), and every login since rewrote both the entry and the
file, so nothing was left for them to promote. The background readers have **no** JSON fallback.
`MlsDeviceKeyStore` is a reader of the device key; its one writer serves the install's native cache
key and refuses an `mls_device_key_` alias (`pushContextFields.test.ts` pins both).

### The at-rest key on a phone is held by the hardware (2026-10-22)

**The user's decision of 2026-10-22, "cle materielle + PIN":** on the phone apps the local at-rest
key is a random key held by the device's secure hardware, the PIN only unlocks it, the PIN stays
short, and backups get their own recovery secret. Web and desktop keep the PIN-derived key above:
a browser has no hardware keystore a key can be bound to (`hardwareHeldKeyApplies()` is
`isMobileTauriRuntime()`).

**The key hierarchy on a phone.**

| Secret | Where it lives | What it opens |
|---|---|---|
| PIN | the user's head | nothing locally; the server's `pin-check` accepts or refuses it |
| At-rest key: 32 random bytes from the OS RNG (`at_rest_key.rs`, `generate_data_key`) | the existing keystore entry `mls_device_key_{userId}_{deviceId}` and its background copy ([above](#where-the-key-lives)) | `mls.bin`, messages, Graine seeds, outbox - every row of [the store table](#what-the-device-key-seals-and-what-a-pin-change-does-with-each) |
| Marker `at_rest_keys/<hex(userId)>.json`, ONE PER ACCOUNT | app data dir, written tmp + fsync + rename | nothing: says which scheme seals this account's data (`pin-derived` by absence, `migrating`, `hardware`), the keystore entry the key was written to, and a 128-bit HKDF check value of the key |
| Backup recovery code (128 bits), ONE PER DEVICE | kept by the user; on the device, sealed under the at-rest key | every `.canari` file the device exports ([below](#backups-get-their-own-recovery-secret)) |

**How the PIN gates the key.** The unlock still derives the verifier and asks the server, exactly as
before (`unlockWithPin`); only the key source changes. On a `hardware` marker the PIN path reads the
key from the keystore (`cle_au_repos_lire`, which refuses unless the key's check value matches the
marker) and installs it ONLY after the server answers `ok`/`registered`. A refusal of the read is a
type, `HardwareKeyUnavailableError`, turned into the login code `hardware_key_unavailable`: no PIN
can derive a random key, so the old-PIN recovery is not offered and the reset is.

**What the server holds, and why it is not enough.** The server still holds the salt and the PIN
verifier, so it can still check the PIN. On a phone the at-rest key is no longer a function of the PIN
and that salt: it is random and lives in the hardware keystore, so nothing the server holds - even
together with a copy of the app's files - yields it without the phone itself. What hardware-holding
does not change: code running on the unlocked phone can read the unattended key, as the background
push already does.

**The migration of an existing install is a RE-KEY, not a re-wrap** (`utils/chat/hardwareKeyMigration.ts`).
Wrapping the PIN-derived key in the keystore would leave every row sealed under a key that is still
PIN + salt, which is the thing the decision removes. So after the first PIN login on a new build the
tab leader runs, once, in the background:

1. `cle_au_repos_preparer`: generates the key, writes the marker `migrating` with its check value
   BEFORE answering. If the marker already says `migrating` and the keystore holds a key whose check
   value matches, that SAME key is returned (rows may already sit under it).
2. `performPinChange(old, new)` - the PIN change's own resumable order: vault slot retired, keystore
   pointed at the new key, every store re-sealed under the storage gate, the session adopts the key,
   the MLS state re-sealed LAST.
3. `cle_au_repos_marquer`: marker `hardware`, only for that user and that check value.

**Rows move only after the key was written AND read back** - the invariant every recovery below rests
on. `cle_au_repos_schema` settles the marker before anyone reads it (`settle_scheme`): a `migrating`
marker whose keystore entry is empty or holds another key is REVERTED (nothing was sealed under a key
that never reached the keystore), so a stuck PIN recovery or a restored marker resolves the same way
every time; a read ERROR answers `unreadable`, never a guess.

**A kill mid-migration is FINISHED AT THE NEXT PIN UNLOCK, before any store is opened**
(`finishMigrationAtUnlock`). A kill in the store pass leaves rows under two keys, and a session run
over that reads half of them as damaged - so no session ever starts on it. Once the PIN is proven:
the keystore key opens the stored state (it moved last, so everything did) and the marker is
completed; or no state is stored and the stores alone move (`moveSealedStoresOnly`); or the state is
still under the PIN-derived key and the re-key runs to the end from the stored state, as the PIN
recovery does. An interruption that moved data reloads the page, and the next unlock finishes it. A
fresh install takes the same path (cheap: nothing is stored yet), so there is ONE code path for every
install. While the marker says `migrating` a biometric unlock is sent to the PIN pad, and a PIN
change waits for the migration and refuses (`auth_pin_change_key_migration_pending`).

**ONE GUARD FOR THE ENTRY: once a marker names the hardware key, NOTHING deletes or overwrites that
entry except the explicit reset.** It lives in the Rust bridge, not at the call sites
(`at_rest_key.rs`: `guard_write`, `guard_delete`; `keystore_bridge.rs`: `store_guarded`,
`delete_guarded`), and every mutation goes through it:

- `store_push_context` at every login, `actualiser_cle_keystore_avec_devicekey`, and mls-core's
  `DeviceKeyStore` (its stale-key probe included) - a write of another key is a typed `Refused`; a
  write of the key already there is SKIPPED (`AlreadyHeld`), so a login rewrites nothing; any write
  that does happen is read back and compared.
- The WebView cannot reach the plugin's store or delete at all: the keystore plugin's default
  permissions grant reads only, and a delete is the app command `supprimer_cle_appareil`, which asks
  the same guard (`nativePluginCommands.test.ts` pins both).
- The explicit reset is `cle_au_repos_oublier`, run only once that account's data is gone: the
  "forgot PIN" reset after its database clear, the account deletion after its native database step
  (and not when that step failed), the factory wipe by removing the whole marker directory first.
- Turning biometrics off no longer touches the entry: it used to delete it and re-store it from the
  session key with every failure swallowed, which on a migrated phone was the only copy of the key.
- iOS rewrites the background copy IN PLACE (`SecItemUpdate`, an add only when absent) before the
  `.userPresence` item, which cannot be updated without Face ID; Android `commit()`s and checks the
  result instead of `apply()`.

Markers are per account and the guard matches an entry by the EXACT alias its marker recorded, never
a prefix: user ids allow `[A-Za-z0-9_.@-]` and device ids embed the user id, so one account's id can
extend another's and an alias cannot be parsed back into its account. A marker that cannot be read
guards EVERY alias (fail closed). Account deletion removes the entry the marker recorded as well as
the one today's device id names (`cle_au_repos_oublier` answers the recorded alias).

**One lock, one order.** A process-wide lock (`AT_REST_LOCK` in `at_rest_key.rs`) covers every marker
read-modify AND every keystore write or delete: the settle, prepare, mark, forget and read commands,
and the bridge's guarded store and delete. `prepare` writes the keystore entry itself, under the lock,
after the `migrating` marker - so a settle never sees the gap between the two and never reverts a
re-key in progress. In the page, every read of the scheme (login, "stay signed in", PIN change,
recovery) goes through `settledAtRestScheme`, which first waits for a re-key running in that page.

**A marker write is durable in its directory.** The temporary file is synced, renamed, and the
DIRECTORY is synced; a creation and a removal sync their directory too (`sync_dir`). A rename that
was never synced in its directory can come back undone after a power loss on F2FS, the file system
of most Android phones - which would resurrect the previous marker. Windows has no directory handle
to sync, so the step is a logged no-op there.

The vault never copies a hardware-held key (`saveDeviceKey`
returns on a key noted by `noteHardwareHeldDeviceKey`): a vault blob sits beside its wrap key in the
app's files, and a copy there would undo the point. "Stay signed in" on a hardware-held phone is
therefore the unattended keystore read (`nativeStorageLoginImpl` -> `loginImpl({ unattendedKeyRead:
true })`).

**Why the push cache keeps its own key (#2271).** That key must exist before the first push and stay
stable; the at-rest key does not exist before the first PIN unlock and rotates (the migration, a
recovery, a reset). Deriving one from the other would tie the push cache to every rotation.

**The notification processes need no change.** The Android `MlsDeviceKeyStore` and the iOS NSE read
the same alias and the same background copy as before (`AfterFirstUnlockThisDeviceOnly`, no access
control; Android key with no user authentication), so a push on a locked phone still decrypts. After
the migration that entry holds the random key instead of the PIN-derived one - the readers never knew
which it was.

**A PIN change on a hardware-held phone re-seals nothing**: only the server verifier rotates, since
the key is not a function of the PIN. A PIN changed on ANOTHER device needs no recovery here either:
the new PIN passes the server check and the key is read as before. The recovery path still exists
for a phone mid-migration, and moves the state to the hardware-held key rather than to PBKDF2 of the
new PIN.

**A lost keystore entry loses the local data.** A keystore wipe, or an iOS restore onto a new phone
(`ThisDeviceOnly` items do not migrate), leaves rows nothing can open: `hardware_key_unavailable`,
the reset, and history from peers and backups. Markers stay IN the backup on purpose: a restored
`hardware` marker without its key reads as that typed state (never a silent reset of good data), and
a restored `migrating` marker without its key is reverted (nothing moved). The reset forgets the
marker (`cle_au_repos_oublier`) once the data is gone, which is what frees the entry.

#### Decisions taken on 2026-10-22, and what each costs

**The product decision (user, 2026-10-22): notifications stay complete on a locked phone, and the
PIN is verified by the server; the hardware key protects the device's stored data. Practicality
first.** So what is built above is the design: a random key held by the hardware, read unattended
by the push and by "stay signed in", with the PIN checked by the server. A design in which the PIN
would enter the key on the phone was studied the same day and not taken, because a locked phone's
notifications need the key with nobody present.

Four questions were settled the same day as lead decisions:

| Decision | What it costs |
|---|---|
| 1. One backup recovery code per device (`crypto/deviceRecoveryCode.ts`) | Losing that code loses every backup the device made; knowing it opens all of them. |
| 2. The key is not bound to the device credential (passcode, enrolled biometrics) | Nothing is lost when a fingerprint or a Face ID is enrolled, and locked-phone pushes and "stay signed in" keep working - which is also why those read the key without the user. |
| 3. A lost keystore entry loses the local data | A keystore wipe, or an iOS restore onto a new phone, leaves rows nothing can open; the login says so (`hardware_key_unavailable`, whose text says the messages on that phone are lost) and offers the reset. History comes back from other members and from backups. |
| 4. A backup made before a phone's move to the hardware key stops opening on that phone | Those older backups cannot be imported there, so once the move re-sealed existing data the phone asks for a new backup: a toast at once, and a notice in the backup panel until an export is saved (`noteBackupOwedAfterKeyMove`). A fresh install, which takes the same path with no data, is not asked. |

#### Backups get their own recovery secret

A `.canari` file is now **v3** (`backup.ts`, `crypto/backupRecoveryCode.ts`): sealed under
HKDF-SHA256(code, per-file salt) where the code is 128 random bits in Crockford base32 (26
characters in groups of four; typed back case-insensitively, `I`/`L` read as `1`, `O` as `0`). 128
bits need no key stretching.

**One code per device** (`crypto/deviceRecoveryCode.ts`): generated at the device's first export
and kept in `localStorage`, SEALED under the device key - never in the clear, since on a phone a
plaintext code beside the app's files would let a copy of them open every backup. It is kept only
once a file was saved with it, so a cancelled save leaves no code nobody saw - and kept INSIDE the
storage gate, under the key the stores are under then (`keepDeviceRecoveryCode`, `liveDeviceKey`), so
a re-key that ran during the save neither races its re-seal of the code nor makes the next export call
it replaced. Every device key change
re-seals it with the stores (`moveDeviceRecoveryCode` in `performPinChange` and
`moveSealedStoresOnly`; never fatal, idempotent for a resumed change). A stored code the key no
longer opens - a reset, an eviction - is replaced at the next export, and the panel says the earlier
files keep their old code. Each export shows the code with what it is: the first, the same as
before, or a replacement. Every message row and seed is
re-sealed from the device key to the backup key at export and into the importing session's key at
import, so the file carries no device key and opens on any device with the code. The MLS state rides
along with a check value of the key it is sealed under (`mlsStateKeyCheck`) and is restored only where
that key is the session's. The settings panel shows the code with a copy button and an "I have saved
it" dismissal, and reads a file's header to ask for the code BEFORE an import (`backupFileVersion`).
v2 files are still read, and open only where the exporting key is the session's - so a v2 file
exported before a phone's migration no longer opens on that phone after it.

**A key change and the background engines** (2026-10-23). A push or a drain loads `mls.bin` and the
key, then works; the re-key (or a PIN change) can re-seal the file meanwhile and the app go to the
background, which drops the foreground guard at once. Every background write of `mls.bin` therefore
compares the file with the bytes the engine loaded, under the lock every writer takes
(`write_over_loaded_state`, `background_write_mls_bin_if_unchanged`): a state loaded under the old
key never lands over one re-sealed under the new. The native seed mirror and push cache are sealed
under the install's own cache key, not the device key, so a re-key does not touch them.

**A background Welcome staged across a key change** (2026-10-23). The sender-side background Welcome
stages its post-add state, bound to the bytes of the `mls.bin` it was built on, and installs it only
once the server accepted the commit, and never while the foreground is active (an install under a live
foreground would be overwritten by its in-memory manager). A key move or a PIN change is a foreground
checkpoint, so during a pending background Welcome it behaves as any foreground open does: the
accepted add is not installed by the background, and the foreground recovers it. Handing an accepted
background Welcome to the foreground is a separate change. What this branch adds: a Welcome is staged
only while `mls.bin` is still the file it was built on, checked under the `mls.bin` write lock
(`stage_over_loaded_state`), so a foreground write that landed while it was built refuses the staging
before its commit reaches the server.

**A key that could not be read is not a key that is lost.** `hardware_key_unavailable` ("the messages
on this phone are lost", reset offered) is thrown only for `absent` and `mismatch`; an unreadable
entry or marker is `hardware_key_unreadable` ("try again"), and the gate withholds the reset for it
(`withholdsResetForUnreadKey`, the shell's `keyReadRefused`, and a second lock in `handlePinReset`).
One function decides (`hardwareKeyLoginFailure`), for the unlock, the migration finish and the PIN
recovery.

**A failed keychain read is an error, never "no key".** The unattended read answers absent for the
platform's not-found status ONLY (`errSecItemNotFound` on iOS); any other status - a locked device's
interaction refusal, an entitlement error - is an error carrying its status
(`keystore_bridge.rs`, `unattended_read_outcome`), so the marker logic never reverts a migration or
replaces a key it merely could not read. The explicit reset forgets the marker only once the
account's database was cleared (`forgetAtRestMarkerOnceDataIsGone`), as the account deletion does.

**Account restore (WP-RESTORE-1, #2065)** restores a server session, never keys: a restored phone is
a device that is born, or migrated, onto its own hardware-held key, and needs nothing from this page.

**Owed on hardware, Mi 9T and iPhone:** fresh install; upgrade from the current store build (and how
long the storage gate is held by the re-key); PIN change; a push readable with the app killed after
the migration; a backup exported, then imported with its code on the other phone; a second export
showing the same code; the new-backup notice after an upgrade with data, and its absence on a fresh
install; "stay signed in" across a restart; biometric unlock after the migration. **No gate compiles
the iOS side** (`KeystorePlugin.swift`, `canari_ios.mm`): it is owed a build on the Mac runner, and
one iPhone reading of the unattended read's status handling (a push with the phone locked before its
first unlock must log the status and refuse, never report the key absent).
Android's Kotlin was compiled locally (`:app:compileArm64DebugKotlin`,
`:tauri-plugin-keystore:compileDebugKotlin`).

### The vault names its account - FIXED 2026-10-14

**The defect, read from the code while reviewing #1862, present in `v1.2.6` and in every build since
the vault replaced the PinVault.** The vault was ONE slot (`canari_device_key_vault`) and nothing in
it said whose key it was; a sign-out keeps it on purpose ("Rester connecte"). So account B signing in
on an install where A had ticked it took the vault path (`nativeStorageLoginImpl` on a phone, the web
branch of `startLoginFlow` in a browser) with A's key, and B's PIN was never asked:

- **Web**: the stores are per account. With no state of B's, the fresh start SEALED B's first state
  under A's key, which B's own PIN then never opened; with one, it did not open and B was offered a
  recovery for a PIN it had never changed.
- **Phone**: `mls.bin` is ONE file per install (`data_dir/mls.bin`). A's key opened it, the
  credential named A, `IDENTITY_MISMATCH`, and the `mismatch` branch of `_initImpl` ROTATED the device
  identity and wrote a fresh state over the file: **A's whole local state, lost**, by a sign-in that
  was not A's.

**The fix: the vault records the account it belongs to, and a sign-in as anyone else never sees
it.** One slot per account, `canari_device_key_vault:v2:<userId>`, and the same string is the AES-GCM
additional data - a blob copied under another account's name does not open, so the label cannot be
edited without the tag noticing. `loadDeviceKey(userId)` reads only the signing-in account's slot;
another account's slot is neither read nor cleared, so A signing back in still unlocks without a PIN.
A failed login clears only its own account's slot. One wrap key serves every slot;
`clearDeviceKeyAndWrapKey` (revocation, biometric enrolment, a persistence switch) drops every slot.
A persistence switch means a REAL change of mode: the PIN modal restates the mode on every submit,
and `setDeviceKeyPersistence(mode, null)` with the mode already set is a no-op - before that, B typing
its PIN erased A's slot and A's "Rester connecte" with it.

**The migration: the unlabelled slot an older build wrote is offered as UNPROVEN, and the login must
prove it.** `loadDeviceKey` returns `{ deviceKeyB64, ownerProven }`, `false` only for that slot, and
the login carries it to `init` as `MlsInitOptions.vaultOwnerUnproven`. Such a key is accepted only if
it OPENS a saved state whose credential names the account signing in. Anything else is refused BEFORE
any recovery can run - `no_state` (checked in `loginImpl` before `resolveDeviceId` mints an id, and
again in both `_initImpl`s), `mismatch`, `unopenable` - as a typed `VaultOwnerUnprovenError`: no
rotation, no fresh start, no legacy re-seal, no write. `loginImpl` turns it into a `LoginFailure`
(`device_holds_other_account` for a `mismatch` on a phone, `vault_not_this_account` otherwise - see
below), drops the key from the session, and keeps the unlabelled slot, which may be the previous
account's. The shell then draws the account's OWN PIN gate
(`openPinModal(uid, { deviceIdUnproven: true })`: first setup or returning is asked of the SERVER,
because a refused vault says nothing about this account's PIN - and the device id cannot answer it
here, since the vault path resolved, and so minted, this account's id before the state refused it).
A same-account stale state (`mismatch` naming another
device of the same account) is refused on this path too, and reaches its rotation through the PIN
path, which proves the account first.

**When the unlabelled slot is retired: after a SUCCESS, and only by its owner.** The slot is offered
to whoever signs in. Once a login has SUCCEEDED and its key is safe in the account's own slot,
`retireUnlabelledDeviceKeyIfOwnedBy(userId, key)` removes the unlabelled slot IF it holds the very key
that account unlocked with - whichever path it took (the slot itself, its own slot, the PIN, the
keystore). A device key derives from the account id, the PIN and the salt, so two accounts never
share one: an equal key IS the proof. Any other key may belong to an account that has not signed in
since, and the slot is kept for it. Before this, an account that unlocked by its PIN or its own slot
left its old copy on offer to every other account for ever.

**What the member is told - two codes, because only one refusal knows whose state is there.**
- **`device_holds_other_account`** - a `mismatch` on a PHONE, PROVEN another account's state (the key
  opened the one `mls.bin`). The error is `auth_vault_other_account_device`, and the gate WITHHOLDS
  THE RESET (decided 2026-10-14): "PIN oublie -> Reinitialiser" runs `handlePinReset` ->
  `resetDeviceAsFresh` -> `removeMlsState`, which deletes that one file - the other account's state,
  from this account's session. `PinModal` gets no `onForgotPinReset` and shows
  `auth_pin_reset_blocked_other_account` instead, on every gate, first setup included; `handlePinReset`
  refuses on its own too, before the server reset and the wipe. The sentence says what is true: this
  device holds another account's messages (it says "device", not "phone": `isTauriRuntime()` is a
  desktop build too, with the same one `mls.bin`), the app keeps one account's at a time, the member can sign
  out and let the other account back in, and the only way to use this account here is to clear the
  app's data or reinstall - which loses the other account's messages. (A PIN reset BY the other
  account would not free the phone: it leaves that account's fresh `mls.bin` in the same file.) This
  account stays locked out on this phone, which is safer than a silent destruction. Cleared by a
  sign-out, a session expiry and a session - the shell is the root layout and outlives `/login`, so
  a flag left set would withhold the reset from the next account's gate, the owner's included.
- **`vault_not_this_account`** - every other refusal (`no_state`, `unopenable`, and any refusal on the
  web, where states are per account). Neither proves anything about another account - the store may
  be this account's own, evicted or sealed under an older key - so the sentence is NEUTRAL
  (`auth_vault_unverified`: the saved unlock could not be verified for this account) and the gate is
  the ordinary one.

**The PIN path is covered by an owner record (PK1, 2026-10-17, unshipped)**: on a phone `mls.bin` is
still one file per install, so once every vault is labelled B takes the PIN path and cannot open A's
file. `initialiser_mls` now records `mls.owner` beside `mls.bin` whenever a state opens, and a failed
load whose record names another account is `device_holds_other_account` on the keypad path too
(`applyPinFailure` -> `noteOtherAccountState`): the reset is withheld. An install whose state
predates the record is covered only after its owner signs in once on the new build
([mls-protocol](../../protocols/mls-protocol.md#the-state-blobs-framing---read-first-write-later)).

Tests: `utils/deviceKeyVault.test.ts` (slots, binding, the unlabelled offer),
`services/TauriMlsService.vaultOwner.test.ts` and `services/WebMlsService.vaultOwner.test.ts` (a
refusal writes nothing; a control proves the rotation is still reachable without the flag), and
`composables/session/accountSwitchVault.test.ts`, which runs the real vault into the real native
init over a `mls.bin` holding A's state: A leaves a vault, B signs in (PIN gate, nothing rotated,
nothing written), A signs back in (the vault unlocks); it also pins the neutral/proven split, the
retirement order and the withheld reset in the shell. `components/auth/PinModal.resetWithheld.svelte.test.ts`
renders the gate without a reachable reset. Mutation-checked: removing the native guard fails three
cases, collapsing the slots into one fails seven, re-offering the reset fails two, retiring the
unlabelled slot without the key comparison fails one.

### How often the sheet comes back - the biometric cadence (2026-09-28)

Settings > Security shows, under the biometric toggle, a per-device choice: **every 12 h**
(default) or **every time**. Every time is the pre-2026-09-28 behaviour, unchanged. Every 12 h
skips the sheet while the last *prompted* unlock is under 12 h old
(`services/biometricCadence.ts`), and the key is then read **unattended**: `initialiser_mls` gets
`unattendedKeyRead`, and `PluginDeviceKeyStore` calls `getKeyBytesUnattended` instead of
`getKeyBytes`. That native method is Rust-only - not a `#[command]`, not in `build.rs`'s ACL, so no
JS can reach it (`biometricCadence.test.ts` pins that, and pins the prompted iOS read to the
`.userPresence` item).

**What it costs, per platform - decided by the user knowingly, not discovered:**

| Platform | Unattended read | Security delta |
|---|---|---|
| Android | the same alias, decrypted with no `BiometricPrompt` | **None.** The key was never auth-bound (see the table above); the prompt was always a UX gate |
| iOS | the background item `mls_bg_key_<alias>` | **Real.** The primary item is `.userPresence`, enforced by the Secure Enclave. Inside the window, code already running with the app's rights on a compromised device (jailbreak, an exploit of Canari) reads the key with no fresh proof. A stolen locked phone or a network attacker gains nothing |

**Why not a hardware-enforced window.** Apple caps reuse of a biometric proof at five minutes
(`LATouchIDAuthenticationMaximumAllowableReuseDuration`); no API gives 12 h. Android's
`setUserAuthenticationValidityDurationSeconds` would, but only after splitting its single key in
two, and it would leave the two platforms asymmetric - the user preferred one mechanism.

**The clock, and why it may exist here despite "never from a clock".** It answers a UX question
(raise the sheet or not), never a cryptographic one, and it obeys the liveness-clock rule: it is
written ONLY by a successful *prompted* unlock (`biometricLoginImpl`), never by an unattended one,
or the window would renew itself without a proof. A clock set backwards counts as due. It lives in
`localStorage` only (the native flag store holds booleans): losing it costs one extra prompt, never
a skipped one. The cadence is stored as its NON-default (`biometricPromptEveryLaunch`, dual-written
like every biometric flag), so an empty store IS the default and existing installs need no
migration. Forgetting biometrics (`BiometricService.forget`) drops the proof and keeps the
preference.

**Who decides "unattended".** The caller of `biometricLogin`, because only it knows whether a
person asked for the sheet: the cold-launch flow (`startLoginFlow`) asks the cadence and then also
hides the in-app `BiometricBottomSheet`; the PIN modal's "use biometrics" button always prompts. An
unattended read that finds nothing (a device enrolled before WP-SEC-1 has no background item) is
the existing `keystore_empty` failure and lands on the PIN modal, whose button prompts.

**Owed on hardware** - nothing here has run on a phone yet: [device-verification](../../device-verification.md).

### The key is raw bytes at rest and base64 on the wire

The device key is stored as **raw 32 bytes** in both platform keystores, and crosses the Rust FFI
as **base64**. Writers (`storeKeyBytes`, `MlsDeviceKeyStore.store`, both one-shot migrations) decode
before storing; readers (`getKeyBytes`, `CanariRetrieveDeviceKey`,
`NotificationService.retrieveDeviceKey`, `MlsDeviceKeyStore.retrieve`) encode after loading.
Treating the stored bytes as text anywhere in that chain silently yields no key - random key bytes
are almost never valid UTF-8, so the reader returns nil and every push falls back to generic text.
`pushContextFields.test.ts` asserts the contract across all five files.

On Android there is a second encoding trap: **`Base64.DEFAULT` appends a newline**, and the Rust
`decode_base64_to_32_bytes` does not trim. Anything crossing into the FFI must use `NO_WRAP`;
`DEFAULT` is correct only for KeystorePlugin's own at-rest IV/ciphertext format. Do not unify the
two.

Android has **two readers over the same alias and the same SharedPreferences**: `MlsDeviceKeyStore`
(background, Context-only) and `KeystorePlugin.getKeyBytes` (foreground, behind the BiometricPrompt).
The `NO_WRAP` fix landed on the first and was asserted only there, so the newline survived in the
second until v0.11.6. Its failure mode is the cruel one: the BiometricPrompt appears, the fingerprint
is *accepted*, the key decrypts - and then Rust rejects the string, `retrieve_device_key` returns
`None`, and `resolve_at_rest_key` answers `KEYSTORE_KEY_UNAVAILABLE` (the prose "No keystore key" until 2026-09-28) so the user is sent to the PIN modal.
Nothing in the log says the key was found, because from Rust's point of view it never was. Both
readers are covered now; the test captures the flag rather than matching the literal, so adding a
`DEFAULT` encode beside a `NO_WRAP` one still fails.

### Biometric mode must hand the key back to the frontend

`deviceKeyB64` seals two different things in two different layers. `mls.bin` is sealed in Rust,
which resolves the key itself; **local messages are AES-256-GCM blobs encrypted in the frontend**
(`db/sqlite.ts`, via `encryption.ts`). Biometric mode calls `init()` with an empty key on purpose -
that empty string is what selects `load_encrypted_with_keystore(pin: None)` - so Rust ends the login
holding the key and the WebView holding nothing.

That asymmetry made every biometric session lose its history writes. `importDeviceKey('')` rejects
(AES-GCM has no zero-length key), so **every stored row failed to decrypt and every new row failed
to be written**, and both persistence call sites swallow their error
(`saveMessages(...).catch(() => {})`). The visible half was a wall of `Failed to decrypt SQLite row`
on the second launch; the silent half was that nothing received during that session was ever saved.
The conversation *list* survived, which is what made it look cosmetic - conversation metadata rows
are plaintext.

`initialiser_mls` already caches the resolved key in `AppState.device_key`, so that saves arriving
later with an empty `device_key_b64` still work (`session_at_rest_key`). `recuperer_cle_session_mls`
returns that cached copy, and `loginImpl` pulls it into the session with `ctx.setDeviceKey` right
after `init()` succeeds and **before** anything reads `ctx.getDeviceKey()`. Reading the keystore
again instead would raise a second BiometricPrompt in the middle of a successful login;
`sessionDeviceKey.test.ts` pins the command to the cache for that reason.

Two invariants around it:

- The **local** `deviceKeyB64` in `loginImpl` stays empty. It means "a key the caller supplied", and
  it gates the device-key vault write and `store_push_context`. Biometric mode must keep both
  skipped - the keystore is where this key belongs at rest.
- A `null` answer **fails the login** (`LoginFailure('keystore_empty')` -> PIN modal) instead of
  continuing. Continuing is a whole session that persists nothing, with nothing in the log; the PIN
  path derives a working key and loses no data.

`TauriMlsService` also fills its own `_deviceKeyB64` from that answer, because
`reloadStateFromDisk` skips on a missing key - and skipping it on every resume is how a background
engine's advance to `mls.bin` gets clobbered by the next save (lost-update -> `SecretReuse`).

### A PIN change must never turn biometrics off

`applyNewDeviceKeyLocally` (`utils/chat/pinChange.ts`) runs in the first step of both the change and
the recovery flow ([the order](#what-the-device-key-seals-and-what-a-pin-change-does-with-each)), and
it must **never** call `BiometricService.disable`. By the time it runs,
`IMlsService.pointUnattendedUnlockAt` has already overwritten the keystore entry with the NEW key, so
disabling there deletes the entry that was just written and switches biometric
unlock off behind the user's back - a settings toggle silently flipped by an unrelated operation.
What it does instead is pick the destination: biometrics on -> keep the keystore authoritative and
`clearDeviceKeyAndWrapKey()` so the next launch still takes the biometric path rather than a silent
vault login; biometrics off -> `saveDeviceKey` into the local vault.

### What the device key seals, and what a PIN change does with each

A PIN change reaches a device in two ways: the user changes it HERE (`changePinImpl`), or it was
changed on ANOTHER device and this one recovers with the old and the new PIN (`recoverPinImpl`).
**The old device key is derivable in both**: it is PBKDF2 of the old PIN over the SAME server salt
(`pin-change` rotates the verifier, never the salt), so nothing has to be dropped and re-asked for.
Both therefore go through ONE function, `performPinChange`, and differ only in where the MLS state
comes from: the live client for a change, the stored blob for a recovery (`storedMlsState`, opened
non-destructively by `IMlsService.openLocalStateWithKey`).

| Store sealed under the device key | Where | Change (before 2026-10-15) | Recovery (before 2026-10-15) | Both, now |
|---|---|---|---|---|
| Messages (incl. salon pages kept without a conversation row) | `IStorage` `messages` | re-encrypted | re-encrypted | re-sealed by `resealDeviceKeyStores` |
| **Graine seeds** | `IStorage` `graine` | re-encrypted | **NOT re-encrypted - lost** | re-sealed by `resealDeviceKeyStores` |
| **Outbox payloads** (text, reply, control frame, the blob KEY of an attachment) | `IStorage` `outbox` | **NOT re-encrypted** | **NOT re-encrypted** | re-sealed by `resealDeviceKeyStores` |
| Outbox attachment bytes | `CanariDBOutbox_<userId>` | sealed by a per-blob key held in the outbox payload, not by the device key: follows the payload | same | same |
| MLS state | `mls.bin` (native), `CanariDBMls_<userId>` (web) | `changeDeviceKey` | `recoverAndRekey` (open + re-seal) | `changeDeviceKey`, LAST |
| Keystore entry + background copy | platform keystore (native) | rewritten by `changeDeviceKey`, unawaited | same | `pointUnattendedUnlockAt`, awaited, FIRST |
| Vault slot (+ an older build's unlabelled slot holding this key) | `canari_device_key_vault:v2:<userId>` | overwritten at the END | same | old slot cleared BEFORE the keystore (`retireOldDeviceKeyFromVault`), new key saved after it (`applyNewDeviceKeyLocally`) |
| Graine native mirror, push message cache | `graine_seeds.json`, `fcm_message_cache*.ndjson` (native) | sealed since 2026-10-22, but under the INSTALL's native cache key, which a PIN change does not touch: nothing to do ([mobile](../mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)) | same | same |
| Feed cache | memory only (`posts/feedCache.ts`) | not sealed, not persisted | same | same |
| Stored feed first pages (#1896) | `IStorage` `feedPages` / `feed_pages` | dropped (`dropStoredFeedPages`) | dropped | DROPPED inside the storage hold, not re-sealed: a copy the server's next answer rewrites |
| Exported backup file | wherever the user saved it | NOT re-sealed: a file the device no longer holds; a v2 import refuses it as "a different device key" | same | v3 (2026-10-22) is sealed under its own recovery code, so a PIN change does not touch it ([hardware-held key](#backups-get-their-own-recovery-secret)) |

**What went wrong, and why both paths are now one.** The rule "what the device key seals, the
change must re-seal" was honoured by the change for the seeds (2026-09, [channel-encryption
§Phase 2](../../protocols/channel-encryption.md)) and never by the recovery, which had its own copy of
the message pass. After a recovery every seed stayed under the old key, and since the server holds no
seed, the channel history was gone from that device unless a member re-sent the seed - and a seed
request goes to members who may be offline. The outbox was missing from BOTH: a queued text was
skipped silently by `getOutboxQueue` and a queued attachment parked as "cannot be decrypted". Two
copies of a list drift; one cannot. `IStorage` now names its sealed stores (`SealedStore`), and
`resealDeviceKeyStores` iterates a `Record<SealedStore, true>`, so a store added to the union without
being re-sealed fails `check`.

**The order, each step chosen so a kill anywhere leaves a state the recovery finishes.**

1. **Proof (recovery only)**: the stored MLS blob opens with the old key (`openLocalStateWithKey`),
   with nothing written otherwise. Its refusal is TYPED by `classifyStateLoadFailure`, because only
   a key refusal (`undecryptable`, `rotated`) is the old PIN's fault: `DeviceKeyMismatchError` ->
   `auth_pin_old_incorrect`. Another device's identity (`mismatch`) or an untyped failure (`unknown`,
   `keystore_unavailable`) refuses EVERY PIN, so it is `LocalStateUnopenableError` ->
   `auth_pin_recover_state_unopenable`, which points at the reset instead of sending the user round
   the same keypad for ever. **The MLS blob
   decides, never the message stores**: their rows may sit under a key older still (a seed the
   pre-fix recovery stranded, an outbox row no earlier change moved), and deciding "wrong old PIN"
   from them refused the right PIN - and on the change path, where the verifier is already rotated,
   every later recovery the same way: a lockout. The change needs no proof here: the server verifier
   has just proven the current PIN.
2. **The unattended unlock moves FIRST**: the OLD key leaves the vault before anything else (this
   account's slot cleared, and an older build's unlabelled slot if it holds this key:
   `retireOldDeviceKeyFromVault`), then the keystore takes the new key (`pointUnattendedUnlockAt`,
   awaited; biometric unlock and background push read it - a refused write DELETES the entry before
   it propagates), then the vault saves it (`applyNewDeviceKeyLocally`). Both skip the server PIN
   check, so had they kept the old key past a kill or a refusal, they would open the MLS state (not
   yet re-sealed) and run a session over stores already half moved - silently, no recovery ever
   offered. With the new key, or none, every way in after a kill asks for the PIN or finds an MLS
   state it cannot open, and is sent to the recovery. The cost: between this step and step 5 a
   background push cannot open `mls.bin` and shows generic text. The vault save runs inside the other
   tabs' hold (below), so two changes from two tabs never race on it.
3. **The stores, under the storage gate** (`db/deviceKeyGate.ts`), **in every tab** - see
   [below](#the-other-tabs-of-the-account). Every `IStorage` handle comes from
   `getStorage`, which returns it through the gate. A change waits for the calls in flight, re-seals
   while every new call WAITS, then RETIRES the old key: from then on any argument naming it is
   forwarded to the new one. So an edit, a message received, a seed received or a message queued by
   the live session during the change lands under the new key - it was held, then forwarded - and a
   flusher still holding the old key reads what the change moved instead of parking it as
   undecryptable. This deletes the overlap rather than healing it with a second pass afterwards. The
   forwarding is a fact the change recorded, never a guess from a failed decrypt; the retired key
   stays in memory for the page's life, where it already was.
4. The session adopts the new key.
5. **The MLS state LAST** (`changeDeviceKey`), still inside the other tabs' hold - and every MLS state
   read and write takes the same lock, so a tab that reloads reads it only once it has moved: it is the recovery's entry point, so while it has not moved, the recovery
   is offered and finishes the stores. In the old order (MLS first) a kill in the message pass left
   it under the new key and the remaining rows under a key no path would ever ask for again.

**A THROW is typed by the stage it stopped at, and the stage decides whether the session ends.** A
kill is covered by the order; a throw is not, because the session would run on. `performPinChange`
turns any throw after `pointUnattendedUnlockAt` into `KeyChangeInterruptedError` (its stage, whether
the keystore moved, logged, never key material):

- `stores` / `mls` (`dataMoved`): rows or the MLS state may sit under the new key while the session
  holds the old one. `changePinImpl` answers with `endIntoKeyRecovery` - a reload, which comes back
  with the new key, cannot open the MLS state and is offered the recovery with the same two PINs
  (`auth_pin_change_interrupted`).
- `keystore` / `vault`: no row and no state moved, so the session's key still seals everything here
  and it RUNS ON. Only the unlock changed (the keystore refused or moved; the vault was cleared), and
  the account already expects the new PIN, so the NEXT unlock is the one sent to the recovery
  (`auth_pin_change_not_applied` says exactly that, without claiming a restart).

The recovery, not logged in yet, has no session to end and says the same two PINs finish it
(`auth_pin_recover_interrupted`). **A re-seal of the MLS state that does not land is a throw too**:
the version guard of `saveMlsStateEncrypted` drops a capture not newer than the stored one - a
follower tab's client, loaded from an older snapshot than the leader last wrote, always is - and it
used to drop the change's write silently while the change logged "Done", leaving the stored state
under the OLD key. The write now answers `written` / `stale` / `collision`, and `changeDeviceKeyImpl`
throws `MlsStateWriteRefusedError` on a refusal: stage `mls`, so the recovery.

**A background push may still write `mls.bin` under the OLD key after step 5, and the recovery heals
it.** On native, the push handler holds the key it unlocked with (the keystore entry it read before
step 2) for as long as it runs, so a push that started before the change can checkpoint `mls.bin`
under the old key after `changeDeviceKey` sealed it under the new one. The next launch then cannot
open the state with the new key and offers the recovery, which opens it with the old key (step 1)
and runs this same path - every store already under the new key counts as DONE. A lost race costs
one recovery prompt, never data. The gate does not hold it: the push runs where the WebView's locks
do not reach.

#### A keychain that cannot hold the biometric item (iOS with no passcode, 2026-10-15)

**The iPhone 12 bench has no device passcode, and the change failed there after the server had
rotated.** Its syslog at the submit: `SecItemDelete`, then `SecItemAdd` of the primary item with
`.userPresence` access control -> LocalAuthentication `-5 "Passcode not set"` -> `errSecAuthFailed`
(`-25293`); the same pair at both recovery attempts, and at EVERY PIN unlock (`store_push_context`).
A `.userPresence` item cannot exist without a passcode, so `storeKeyBytes` threw on every call, and
`pointUnattendedUnlockAt` - awaited since #1898, and OUTSIDE the typed `try` - let it escape
untyped: "n'a pas abouti, reessayez" against a server that now refused the old PIN, then the same
refusal in the recovery. Four things changed:

- `storeKeyBytes` reads the FACT (`LAContext.canEvaluatePolicy(.deviceOwnerAuthentication)`,
  `passcodeNotSet`) and writes no primary item on such a phone - biometric unlock, its only reader,
  cannot be enabled there either. The background copy is written in both cases.
- It deletes BOTH old items before writing either. It used to delete the primary, throw on its add
  and never reach the background copy, which kept the OLD key - the very unattended unlock step 2
  exists to retire.
- The keystore step is inside the typed `try`, as stage `keystore` (`dataMoved` false). Tested from
  the state the bench was left in (server on the new PIN, keystore refusing, every store and the MLS
  state under the old key): the change is typed and moves nothing, and the recovery then finishes.
- The vault's old key leaves BEFORE the keystore is asked (it used to leave after). A refusal left
  the vault on the old PIN: a device without biometrics logged in silently on PIN1, past the server
  check and with no recovery offered, and its next change (PIN2 -> PIN3) derived its "old" key from
  PIN2 - rows under PIN1 opened under neither key, the live MLS state moved to PIN3, and messages,
  seeds and outbox were stranded under PIN1. A refused keystore write now also deletes the entry,
  for a refusal raised before the native deletes (a malformed key, a platform that throws first)
  with biometrics on.

**Owed to a device, and only to a device**: the Swift half compiling (macOS CI), the recovery
finishing from the bench's left state, and what removing the passcode with biometrics on does
([backlog](../../backlog.md)).

#### The other tabs of the account

**The in-realm hold covers one JavaScript realm, and on the web one database is shared by several.**
Every tab of the account opens the SAME IndexedDB - the stores and `CanariDBMls_<userId>`. A follower
tab writes outbox rows with the key IT holds in memory (only the leader encrypts and flushes,
`tabMessageSync.ts`); the leader checkpoints its MLS state, sometimes seconds after it captured it; a
tab that reloads reads that state at boot. Unheld, a follower's row written after the pass stayed
under the old key and the leader's flusher parked it as "payload cannot be decrypted" (`outbox.ts`);
an old leader's checkpoint landed after step 5 and put the state back under the OLD key; and a tab
reloading mid-change read the old-key state with the vault's NEW key and was sent to a recovery for
nothing. So the gate holds REALMS too, with the Web Locks API `tabLeader.ts` already elects with:

- every realm holds `canari-device-key:<userId>` in SHARED mode while it may touch the databases,
  joined BEFORE the login reads a key (`joinDeviceKeyLock`). Every `IStorage` call AND every MLS
  state read and write (`loadMlsState`, `saveMlsStateEncrypted`, through `withDeviceKeyHeld`) waits
  until it holds it;
- the changer QUEUES the EXCLUSIVE mode first (so a tab opening from then on - a reload, a new tab
  that read the vault's new key - queues behind it), then posts `key_change_starting` on the
  `canari-device-key` channel, then lets go of its own shared hold;
- a tab that hears it goes STALE, logged once: every later call is refused with
  `StaleDeviceKeyError` (an old leader's checkpoint included), its calls already inside finish, it
  releases the lock, and it ends into the recovery (`endIntoKeyRecovery`: a reload, whose first MLS
  read waits behind the change and so opens a state already moved, with the vault's new key);
- the exclusive mode starts only once every other tab has let go, and covers the vault, the stores
  AND the MLS state (steps 2 to 5). The changer's own calls do not wait for the lock meanwhile
  (`changing`): its in-realm hold covers them, and the MLS re-seal of step 5 goes through the gate
  itself, so waiting there would wait on the change that waits on it.

**The epoch, for what the lock and the notice cannot reach.** The changer bumps a counter
(`canari-device-key-epoch:<userId>` in `localStorage`) inside the exclusive mode. Every realm records
it when it joins, before its key is read, and checks it every time the shared mode is granted again:

- **a suspended page lets go - but never with a call inside.** A page in the back-forward cache or
  frozen runs no code, so it cannot hear the notice, and holding the lock it would hold every change
  for as long as it sleeps. It releases on `pagehide` (persisted) and `freeze`, asks again on
  `pageshow` / `resume`, and a newer epoch on that grant makes it stale before it writes anything.
  A page suspended while a gated call is INSIDE (between its read and its write) keeps the lock until
  that call leaves: released, it would resume after another tab re-sealed and write its row under the
  OLD key before any epoch check - lost for good. The change waits meanwhile, and says so;
- **a frozen page whose shared request was still queued** is granted the lock while frozen (the
  grant needs none of its code to run), so it holds it like a page frozen holding it: the next change
  shows `waiting_tabs` until that page is resumed or closed;
- **an epoch that is GONE is not a change.** Every change writes 1 or more, so an absent counter under
  a realm that joined with a number means the site's `localStorage` was cleared while IndexedDB
  stayed. It is logged and written back, rather than read as `'0'` - which reloaded an open tab for
  nothing and refused the next change as superseded;
- **two changes from two tabs are ordered, not raced.** A notice heard while this tab is itself
  changing never reloads it (that would abandon a change half made): it finishes its own, then lets
  go once so the other's exclusive mode can start. The second change finds the epoch moved and stops
  with `KeyChangeSupersededError` before its vault step; its tab restarts
  (`auth_pin_change_superseded`). **The server is ordered the same way**: `POST
  mls/security/pin-change` swaps the verifier with a conditional update on the one it compared
  (`security.controller.ts`), so of two changes that both passed the check, the second is refused as
  a wrong current PIN - it used to be a read-then-save, where the LAST write decided the account's
  PIN while the first exclusive lock decided the local key.

**A page that is suspended WITHOUT either event** (iOS Safari in the background) keeps its lock, and
the change waits for it - never on a timer. The changer asks the lock manager whether another tab
holds the lock and, if one does, says so on screen (stage `waiting_tabs`,
`auth_changepin_progress_waiting_tabs`: close that tab or bring it to the front).

Without `navigator.locks` (WebKitGTK; the unit tests) the realm is alone, the reading `tabLeader.ts`
makes of the same absence.

**A change is made from the LEADER tab only** (`thisTabMayChangeDeviceKey` in `pinChange.ts`,
asked by `changePinImpl` before the server verifier is rotated). A follower re-seals its own live
client, loaded from an older snapshot than the leader last wrote, so the version guard refuses that
write and the change ended in a recovery prompt every time. Re-sealing the STORED state instead was
weighed and rejected: the change makes the leader go stale and reload, the reload frees the leader
lock, the follower is PROMOTED, and the promotion handler (`useChatSession.svelte.ts`) reloads it in
the middle of its own change - holding that promotion would be a new cross-tab mechanism. So a
follower (or a tab whose leadership is still undecided) refuses on the settings screen with
`auth_pin_change_follower_tab` - change it from the active tab, or take over here first - and
nothing is asked of the server. Pinned by `pinChange.followerTab.test.ts` (two realms).

**Resumable, because it cannot be atomic.** SQLite through the Tauri plugin has no multi-statement
transaction (`sqliteBatch.ts`), so a history of thousands of rows cannot be swapped in one step, and
a phone can be killed half way. Each row is classified by the key its own GCM tag verifies under -
the only record of which key sealed it: under the old key it is re-sealed, under the new key it is
DONE, under neither it is left exactly as it is and counted (never a refusal: the old key was proven
in step 1). A run cut anywhere leaves every row under one of the two keys, and the next run with the
same two PINs finishes it. **Memory**: one store's ciphertexts are read whole (the footprint the old
message pass and a backup export already had), then sealed and swapped 200 rows at a time, so the
new ciphertexts held at once are one batch - not a second copy of the history.

**Each write is a compare-and-swap** (`IStorage.swapSealedPayloads`): the row changes only if it
still holds the ciphertext it was read with, so even a writer that escaped the gate cannot be
overwritten with an older payload or have a deleted outbox row brought back (a duplicate message).
Under the gate that count is expected to be 0, and a non-zero one is logged as an ERROR naming the
bypass. The plaintext BYTES are re-sealed (`openSealedBytes` / `sealBytes`), never parsed and
re-serialised. Logs carry counts only - never a row id, never key material.

**What is tested, and what is not.** `pinChange.test.ts` runs against the real IndexedDB backend
(fake-indexeddb):
- all three stores move;
- a wrong old PIN is decided by the MLS state, before the keystore, the vault or a row moves;
- a row under an older key, even every row, refuses nothing;
- the order: vault cleared, keystore, vault saved, the three stores, MLS state;
- PIN1 -> PIN2 refused by the keystore, relaunch, recovery, then PIN2 -> PIN3: the vault no longer
  unlocks on PIN1, the recovery is offered and finishes, and the next change strands nothing - fails
  with the vault cleared after the keystore;
- `TauriMlsService.keystoreRefusal.test.ts`: a refused keystore write deletes the entry, then
  propagates;
- a run killed at its second batch is finished by the next;
- writes the live session makes DURING the change (an edit, a new message, a seed, a queued message,
  all with the old key) land under the new key - fails with a gate that does not hold;
- a caller still holding the retired key reads what was moved;
- a call already INSIDE the store when the change starts finishes before the pass reads - fails
  without the drain;
- an older build's unlabelled vault slot holding the old key is retired before the new key is saved;
- a state no PIN opens (`mismatch`, `unknown`, `keystore_unavailable`) is not "old PIN incorrect";
- a throw in the stores or the MLS re-seal is `KeyChangeInterruptedError` with `dataMoved`, and a
  throw at the vault step is one WITHOUT it (rows all still under the old key);
- `WebMlsService.changeDeviceKey.test.ts`: a re-seal the version guard drops (`stale`,
  `collision`) fails as `MlsStateWriteRefusedError`; `hex.mlsVersion.test.ts` asserts the outcomes.

`deviceKeyGate.crossRealm.test.ts` runs two realms (two imports of the gate) on one IndexedDB, with
a Web Locks double (FIFO per name, shared/exclusive) and a broadcast double that never delivers to
its poster: the pass does not start while the other tab's write is inside, that write is moved, its
writes after the notice and after the change are refused, the screen is told it waits, and a tab
opening mid-change waits behind it; a reloading tab's MLS read waits until the state has moved; a
stale tab's checkpoint is refused; the changer's own calls inside the change do not deadlock (fails
without the `changing` bypass); of two concurrent changes the second stops superseded and neither tab
reloads mid-change (fails if a notice reloads a changing tab); and a page put in the back-forward
cache lets go, then finds the key retired when it comes back; a page suspended with a call inside
keeps the lock until that call has written (fails without the deferral); and a cleared epoch neither
reloads the tab nor refuses the next change (fails if absent reads as `'0'`).
`security.controller.spec.ts` pins the server's conditional swap and its refusal of the second of
two concurrent changes.
- the compare half of the swap leaves a row holding another ciphertext untouched - fails if the
  IndexedDB swap checks only that the row exists;
- both PIN paths are pinned in the source to `performPinChange`.

The SQLite statement (`sealedSwapStatement`) is unit-tested for its shape; it was run once by hand
against a real SQLite (`node:sqlite`, 2026-10-15: a full 166-row batch swapped 166, a stale and a
deleted row untouched) and has **not** run on a device yet. Neither has the awaited keystore write,
nor the cross-tab hold in a real browser.

#### The login after a recovery read no groups - a false "partial restore" (iPhone 12, 2026-10-15)

**The recovery PASSED on the iPhone 12 (`1.2.9-alpha.2`) and its login then said a conversation
could not be restored.** `[ERROR] Partial restore: 0/1 ... missing 3122333c`, the conversation
demoted to pending, then the re-add's external join refused with `group 3122333c… already present
locally` - the native manager held the group the restore check said was missing. The cause:
`openLocalStateWithKey` marks the client initialised so the login skips `_initImpl`, and
`_initImpl` is what lists the native groups into `TauriMlsService._knownGroups`, which
`getLocalGroups()` reads. So the login after a recovery ran on an empty cache: the banner, the
demotion, the failed rejoin, until the next cold start listed the groups.

**And one durable deletion.** `hydrateDistributionGroups` deletes every key-group row whose group
`getLocalGroups()` does not name, and it read the same empty cache: `[GRAINE] key-group registry
restored before the drain - 0 group(s), 1 row(s) for groups no longer held deleted`. The community's
key group then took the conversation path and failed - part of the cascade, and the one part a cold
start did not undo.

**What the recovery's open now does - everything `init` does after its load** (2026-10-16, review
of #1935). `openLocalStateWithKey` runs `afterStateOpened()` and then `reconcileSendRatchets()`,
inside the `initPromise` a concurrent `init` returns, set before either is awaited (so no second
`initialiser_mls` starts during the listing):

- **The listing.** On Tauri `afterStateOpened` rebuilds the group caches from the native manager; the
  web reads WASM live and needs nothing.
- **The ratchet burn.** It lived in `init` alone, which the login after a recovery skips: an app
  killed after sends it never checkpointed, PIN changed elsewhere, opened a state behind its own
  sends, and the next send re-used a spent generation.
- **A typed refusal.** A failed listing throws `LocalStateNotReadyError` instead of logging and
  running on the empty cache - the whole cascade again. The open is not marked initialised, and
  `recoverPinImpl` reports `auth_pin_recover_interrupted`: nothing moved, the same two PINs retry.
- **A deletion gated on knowing.** `hydrateDistributionGroups` asks `heldGroupsKnown()` first; on
  Tauri it is true only once a listing succeeded for the loaded state, so an unfilled cache deletes
  nothing and says so at error level.

`TauriMlsService.recoveryGroups.test.ts` carries one test per point; each fails on the code before.

**The `LOST frame` lines that followed are this defect's cost, not the PIN lock's.** The false
verdict sent a `welcome_request`; the peer's Welcome then made the client drop the group it held
(`GroupAlreadyExists - forget storage + re-join`) and re-join at a newer epoch, so the frames sent
while the device was locked - queued, and decryptable by the group it held - became frames of a
past epoch. The history diff re-asked them (`raiseReconcile`, `[HISTORY_RECONCILE]`): **asked, and
the answer was not observed** - `session-0002-restore.txt` carries the request and no reply, so
whether those messages came back is not known. With the cache right, nothing is dropped and the
queued frames decrypt as they are drained.

### An at-rest format change needs its own reader, in the same commit

Every at-rest envelope here is a byte layout with no version field: `mls.bin` is
`[nonce 12 || ciphertext]`, the keystore blob is KeystorePlugin's own IV/ciphertext pair, and the
SQLite rows are AES-256-GCM blobs. Nothing negotiates, so **a commit that changes one of those
layouts must ship the reader for the previous layout with it**. Shipping the writer first is not a
staged rollout: installed devices hold bytes in the old shape, the new reader rejects them, and the
failure surfaces as an unopenable state - which `classifyStateLoadFailure` reads as `sealed` or
`mismatch`, neither of which is what happened. The WP-SEC-1 one-shot migrations (deleted
2026-10-22, see [where the key lives](#where-the-key-lives)) were the shape this takes: read the
old, write the new, strip the old, all at the first start after the upgrade - and a migration that
WRITES a key must go through the same guard as every other writer.

### The login guard cannot tell a caller's flag from a concurrent login

`loginImpl` refuses to run when `isLoginInProgress` is already set. `startLoginFlow` sets that same
flag before any `await`, for a different reason - `+layout.ts` must not fire `fetchUserProfile`
while a login is pending. Both read and write one variable, so **every entry point that calls into
`loginImpl` has to release the flag first**. The web branch and `nativeStorageLogin` did; the
biometric branch did not, and so the automatic biometric attempt of every cold launch was swallowed:

```
[BIOMETRIC] Biometric login attempt (keystore key path)...
[BIOMETRIC] Authenticating for userId=... via device keystore...
[LOGIN] Call ignored, a login already owns the flow (loggedIn=false, reconnecting=false, loginInProgress=true)
```

The sheet appeared, no OS prompt ever did, and the flow fell through to the PIN modal - where
tapping "use biometrics" worked, because the fall-through had cleared the flag on the way. That is
the whole "biometrics only work on the second try" report, and it is deterministic, not a race.
Re-entrancy is guarded separately by the component-local `_loginInProgress`, which is why releasing
the shared flag here is safe.

### When a state still refuses to open

The PIN modal's "forgot PIN" (`handlePinReset`) wipes the server-side and local MLS state and
restarts in first-setup mode. It costs the local history and is the last resort, after
`classifyStateLoadFailure` has ruled out a recoverable `sealed` state - see
[`protocols/mls-protocol.md`](../../protocols/mls-protocol.md).

### A damaged local state was called a first connection, and that is what hid the way out - FIXED 2026-09-21

**THE SCREEN SAID TWO THINGS THAT CANNOT BOTH BE TRUE, AND OFFERED NOTHING.** Measured on W2 on
2026-09-21: the gate announced *"Premiere connexion - choisissez votre PIN"*, accepted a PIN, and
answered *"Vos messages enregistres sur cet appareil n'ont pas pu etre ouverts ... seule la
reinitialisation redonne acces a vos conversations"* - with no reset anywhere on it. A reader in
that state can neither unlock nor reach the one remedy they were just given. Repeating the PIN
repeats the refusal for ever.

**THE TWO FACTS COME FROM DIFFERENT PLACES, AND NOTHING SAID THEY COULD NOT DISAGREE.**

| | fact | where it is read | what it decides |
| --- | --- | --- | --- |
| `isFirstPinSetup` | this account has no `PinVerifier` row | the SERVER, `GET /api/mls/security/pin-status/:uid` | the gate's wording, **and both of its exits** |
| `local_state_unopenable` | this device's own MLS blob will not open | LOCALLY, the AEAD tag on `mls.bin` | the error the gate shows |

`detectFirstPinSetup` is careful about its half - it defaults to `false` on any failure so the
"first setup" wording is never shown by mistake - and it is still only evidence for the question it
was written to answer, which is *has this account ever registered a PIN*. It is not evidence for
*is this device new*. `PinModal.svelte` gates **both** ways out on it, `{#if !isFirstSetup}`
around the forgot-PIN disclosure and `{#if !isFirstSetup && onRecoverPin && displayError}` around
the old-PIN recovery, so the server's answer silently decided a local question.

**IT IS PRODUCTION-REACHABLE, AND THE CONTROL THAT ESCAPES IT IS WHAT PRODUCES IT.**
`handlePinReset` POSTs `pin-reset` and then runs `resetDeviceAsFresh`. The second half can
fail on its own, and what it leaves
behind is the server row gone and the local blob still there: this pair, exactly, with the reset
now off the screen.

**THE FIX, AND WHY THE ASYMMETRY IS THE PROOF IT IS THE RIGHT ONE.** Three handlers in
`ChatBackgroundService.svelte` receive `onLoginFailed(message, code)`. `onSavedPinFailed`, the
stored-PIN path, has always cleared `isFirstPinSetup` on a rejection; the two INTERACTIVE
handlers - the ones a person reaches by typing - never did. They now all dispatch through one
`applyPinFailure`, which clears the flag when `provesLocalStateExists(code)` and then evaluates
the recovery as before.

`provesLocalStateExists` is a SECOND predicate over the same codes rather than a reuse of
`isRecoverableWithOldPin`, and the two part company on `pin_mismatch`: a mismatch against an
account-wide verifier says nothing about what is on this disk, so reusing the first would call a
device holding nothing "not a first setup" on a plain typo. Same rule as everywhere else here -
[a column is only evidence for the question it was written to answer](../../durable-rules.md).

Guarded by `layout/pinFirstSetupRefuted.test.ts` (a source guard, for the reason its sibling
`sessionExpiredRelease.test.ts` states: what broke is a missing statement in two of three sibling
handlers) and by the `provesLocalStateExists` cases in `session/loginErrors.test.ts`, whose
exhaustive case fails the day a code is added to the union and nobody decides which side it is on.

### Erasing a revoked device, and the 1.25 s that undid it

`wipeRevokedDevice` (`session/sessionAuth.ts`) is the one consequence of one fact - this device is
revoked - reached from the three places that can learn it: the PIN check at login, the
`device_revoked` frame on a live session, and a vault or biometric login asking the server. Its
steps are ORDERED, and the order is the whole mechanism:

1. `tearDownLiveSession(ctx, cb, 'revoked')` - stop everything that is running.
2. `resetMls()` - destroy the MLS client.
3. `resetDeviceAsFreshImpl` - drop this user's MLS state, device id and local database.
4. `clearAuth()` - revoke the refresh credential, which needs the network context to still exist.
5. `wipeDeviceToFactory()` - every `CanariDB*` database, every cache, `localStorage.clear()`.
6. `setPin('')` - last, because the wipe is what makes the PIN meaningless.

**Step 1 did not exist until 2026-08-28, and its absence made steps 3 and 5 temporary.** Measured on
production to the millisecond: the server recorded the revocation at 08:40:39.773, the wipe ran, and
at 08:40:41.02 the SYNC_WATCHDOG - a 5 s interval nothing had stopped - found ten conversations still
in the live map and an empty WASM. It drove `requestReAdd` for all ten, which re-marked every group
in the `mls_not_ready_since` registry and, through `ensureMls()` (which builds a client whenever it
finds none), REBUILT the per-user MLS database. The device kept 8.2 MB of the install it had just
erased, and `[RESET] done - nothing of this device remains` was printed over the top of it.

`logoutImpl` (now `endSessionImpl`; it had no caller from 2026-04-09 to 2026-10-14, see the
sign-out section below) had always done this teardown properly - four timers, the outbox, the offline-promotion
and peer-return listeners, the history probe sender, the conversation map that IS the watchdog's
candidate set. The revocation path had a comment claiming it did ("tear the session down first ... so
nothing left running can write a key back") and in fact only called `resetMls()`, which nulls a
reference and stops nothing. `tearDownLiveSession` is that teardown, shared, with `reason` as the
only discriminator: a revoked device does not FLUSH its MLS state on the way out (that write is what
the wipe exists to remove) and does not deregister a push token the server deleted when it revoked
the device.

`wipeDeviceToFactory` now also reads the stores back and NAMES whatever survived, because it had been
reporting the steps it ran as though they were the state of the disk. A second, delayed audit was
deliberately not added: the login page's "reset" button is the other caller, and a user who signs
back in writes keys within seconds, so a late check would accuse an ordinary new session of being a
zombie.

**And what step 5 REACHES was platform-dependent until the same day.** `wipeDeviceToFactory` had one
`if (isTauriRuntime())` whose two arms were the native stores and the WebView's, so a phone got
`mls.bin` and every `.db` in the app data directory deleted and kept its IndexedDB. A Pixel 6a
measured on 2026-08-28 held a 5.9 MB `CanariDB_<userId>` after the wipe. The tell was inside the
function already: the cache and `localStorage` steps sat outside the branch, and only the databases
had been pulled in. **Every platform has a WebView, so the native steps are an ADDITION**, and the
web cleanup now runs unconditionally.

That database should not have existed at all, and the reason it did is worth more than the wipe fix.
Inside Tauri the message store is SQLite - `getStorage` picks it, and the MLS state persister writes
`mls.bin` to the filesystem beside it without consulting that choice - so nothing on a phone writes
`CanariDB_*`. What created it was a READER naming its backend by hand: the posts mini panel built an
`IndexedDbStorage` directly, which on a phone answered the sidebar from a database nothing writes
while the chat answered from SQLite, and brought that database into existence by opening it. Naming a
backend does not pick a slower path, it picks a different DEVICE; `db/backendChoice.test.ts` now
refuses any call site outside `db.ts` that does it.

**AND IT STILL KEPT BOTH DATABASES, BECAUSE `deleteDatabase` DOES NOT FAIL ON AN OPEN CONNECTION -
IT BLOCKS.** Measured by HEAL-REVOKE-5 on prod, 2026-08-29, on a build carrying every fix above: the
frame arrived, the server confirmed, `[RESET] wiping this device back to a fresh install` ran, no
step reported a failure - and the survey named `CanariDBMls_<userId>` and `CanariDB_<userId>` as
survivors, with `CanariDBMls_... is still open elsewhere - delete deferred` one line above it. The
disk agreed: two databases, `empty: false`.

"Elsewhere" was this application. `hex.ts` caches its handle on the MLS database in a module-level
`_dbPromise`, opened on first use and **never released** - and `removeMlsState`, which step 3 calls,
REOPENS it. So the last thing a revoked device did before step 5 was guarantee the connection step 5
would block on. `closeMlsDb()` closes it, and it is called from inside `wipeDeviceToFactory` rather
than passed by a caller: the `closeStorage` parameter exists for the message store, which the session
OWNS and can hand over, while a module singleton inside a util is something no caller can see. **A
parameter documented as necessary that no production call site passes is not a parameter, it is a
comment** - both real callers passed nothing, and only a unit test ever supplied one.

The same run found the second half: a delete that ERRORS resolved silently, so a failed delete and a
successful one were the same event, and only the one that happened to log `blocked` could be told
apart. It logs now.

**AND THE MESSAGE STORE CAME BACK A DAY LATER, WHICH IS WHERE THE REAL SHAPE WAS.** HEAL-REVOKE-9
measured it on prod on 2026-08-30, on a build carrying everything above: `CanariDB_<userId> is still
open elsewhere - delete deferred`, then `1 store(s) SURVIVED the wipe`, and the store gone only when
the tab later happened to navigate. The paragraph above had the reason half right - the session OWNS
its handle and can hand it over - and the half it had wrong is the one that matters:

**`getStorage()` IS A FACTORY, SO THE NUMBER OF CONNECTIONS IS THE NUMBER OF READERS.** Every call
constructs a new `IndexedDbStorage` and opens its own connection; only the session's is reachable
afterwards, through `ctx.getStorage()`. Loading `/posts` was measured holding two - the session's,
and `ConversationsMiniPanel`'s, which states in its own comment that it never closes and cannot: on
Tauri `close()` tears down a pool shared with the live session. So the wipe closed one connection of
two and blocked on the other, and a `closeStorage` parameter could never have closed more than the
one the caller already had, whoever passed it.

`db/indexeddb.ts` now keeps a REGISTRY of the connections it has open - added on `onsuccess`, removed
on `close()` - and exports `closeOpenIndexedDbStores()`, which `wipeDeviceToFactory` calls before it
deletes anything. That is the same answer `closeMlsDb` gives, generalised: **a module that hands out
connections owns the list of the ones it has open**, because no caller can see the others. The dead
parameter is gone. The rung asserts it directly now, as `noStoreSurvivedTheWipe`, rather than letting
the product's own accusation sit inside a compound that said only "the wipe did not finish".

What the wipe reaches, per platform, is therefore:

| Store | Web | Tauri |
| --- | --- | --- |
| MLS state | `CanariDBMls_<userId>` (IndexedDB) | `mls.bin`, via `delete_mls_state` |
| Messages and conversations | `CanariDB_<userId>` (IndexedDB) | `*.db` in the app data dir, via `clear_app_data` |
| WebView stores | deleted | deleted - and this is the half that was missing |
| Response cache, `localStorage`, `sessionStorage` | deleted | deleted |
| Biometric key | n/a | `BiometricService.forget(alias)`, per recorded alias |

`native_flags.json` is deliberately not deleted: it holds UI booleans, the biometric one of which is
cleared by the step above, and no account data.

**AND THE WIPE STILL LEFT EVERYTHING, BECAUSE IT KILLED THE APP 55 ms IN.** Measured 2026-08-28, on a
Pixel 6a carrying the unconditional cleanup above: the phone was revoked from its owner's panel and
kept its `CanariDB` and 5.9 MB. Its logcat is the whole diagnosis, in four lines:

```
14:12:21.657 [WS RCV] device_revoked - this device was deleted by its owner
14:12:22.218 [RESET] wiping this device back to a fresh install
14:12:22.223 Tauri plugin: pluginId: biometric, command: authenticate
14:12:22.273 FATAL EXCEPTION: main
             ClassNotFoundException: androidx.coordinatorlayout.widget.CoordinatorLayout
```

Three defects met at that step, and each one alone was enough to keep the conversations.

**The class was not in the APK - zero occurrences of `coordinatorlayout` in all twelve dex files.**
`build.gradle.kts` excludes `com.google.android.material:material`, correctly, on the assertion that
no Kotlin file in this app or any bundled plugin names a class from it. The assertion was true and
could not see the reference: `app.tauri.biometric`'s `auth_activity.xml` inflates `CoordinatorLayout`
as its root view, `material:1.7.0` was the only path to `androidx.coordinatorlayout` in the resolved
graph, and excluding a module drops what only that module contributed. So the exclusion stays and the
class is declared back explicitly. **Any biometric call had the same fate**, which means biometric
unlock on Android was broken for as long as the exclusion has been in - nothing here compiles the
Android app in CI, and `androidBiometricLayout.test.ts` reads the two declarations as a pair because
that pair is checkable nowhere else.

**The wipe asked the holder for a fingerprint before deleting the key.** `BiometricService.disable()`
is `authenticate()` then delete, and its prompt is load-bearing for the Settings toggle: cancelling
must leave the key intact. On a revoked device that is exactly backwards - the person at the sensor
may be whoever took the phone. `forget()` is the same deletion with no prompt, `disable()` is now
`authenticate()` followed by it, and the wipe calls `forget`.

**And the step deleted no key.** It passed no alias, and `deleteKeyBytes` is never called without
one, so "the biometric key" cleared two flags and left the keystore entry that decrypts `mls.bin`.
The aliases are now rebuilt from the `mls_device_id_<userId>` records the device itself keeps -
which is what lets the wipe sweep them with no session to ask - and read
BEFORE `localStorage.clear()`, since that is the store they live in.

The step now runs LAST. `step()` catches a rejected promise, which is every failure this file can
survive; a native activity that fails to inflate is not one, and everything after it was its
hostage. That ordering is a property, not a style choice, and a test asserts it.

**AND THEN IT LEFT THE NATIVE HALF, WHICH NO WIPE HAD EVER LOOKED AT.** Measured on the same phone
the same day, with the crash fixed and the WebView genuinely empty (`canariDatabases: 0`, 261
localStorage keys down to 0): `adb` found twenty-nine paths of account state still on disk. `mls.bin`,
`canari_<userId>.db` and its WAL, `graine_seeds.json` and `channel_keys.json` - the material the
background push service decrypts notifications with - `push_context.json`,
`pending_push_secret.txt`, `fcm_token.txt`, `session-meta.json`, `shared_prefs/keystore_aliases.xml`,
five `shared_prefs/canari_*.xml`, `logs/Canari.log`, and six `files/avatar_<sha1>.jpg`: cached
photographs of real people.

**One line caused all of it.** `clear_app_data` deleted an entry only when
`path.extension() == Some("db")`. Every file in that list was added to the app data directory after
that filter was written, none of them carries the extension it could see, and a wipe whose default is
SURVIVE reports success either way. The same filter never matched `mls_pending.db-wal` or `-shm`
either - a gap a comment three functions away had already written down and deferred.

`wipe_app_data` now deletes every top-level entry EXCEPT a named `KEPT_AT_TOP_LEVEL`, so the default
is erasure and a file added tomorrow needs no one to remember it. That list is short and every name on
it has a reason:

| Kept | Why |
| --- | --- |
| `app_webview` | the engine running this code is reading out of it - deleting it is the `SIG: 9` above |
| `no_backup` | WorkManager's live database |
| `cache`, `code_cache`, `app_textures`, `databases`, `lib` | the framework's, and re-derived |
| `files`, `shared_prefs` | SHARED with Firebase - emptied by prefix instead (`avatar_`, `canari_`, `keystore_aliases`) |

The two shared directories are the fragile part, and a first draft that left them off the list
deleted Firebase's installation id and made both prefix lists dead code. A test creates a realistic
tree of each and asserts both halves: ours gone, theirs untouched.

Failures are isolated and counted per entry, not `?`-propagated at the first one, and logged at a
level that accuses - the same lesson as the ordering above, one layer down: a sweep that abandons its
remaining work on one unremovable file is a sweep whose result depends on directory order.

**The border between the two sweeps is drawn twice, facing each other.** `KEPT_AT_TOP_LEVEL` says
what the native sweep must not touch; `OUR_NATIVE` in the harness's `phone.mjs` says what must be
gone after it. Neither is a fallback for the other, and a row about a phone that reads only the
WebView has measured the smaller half - which is how this survived two fixes.

**A device revoked while OFFLINE is not wiped offline, by design.** Every login path asks the server
`isDeviceRevoked`, which answers `false` when it cannot be reached - a status code is an answer, a
transport failure is not - so the wipe happens at the first login WITH a network and never on a dead
link. One residue follows from the same fact: nobody is there to receive `notifyDeviceRevoked`, so
the device's `auth_sessions` row lives to its 7-day expiry.


#### The wipe's first step is what started the login that undid it

**Step 1 is `tearDownLiveSession`, and one of the things it does is set `isLoggedIn` false.** That
flag is also one of the three `loginImpl` reads to decide that nobody owns the flow, so the wipe's
own opening move announces a free slot to the thing most able to defeat it. Measured on production
2026-08-29, three milliseconds after a `device_revoked` frame: a login started, asked the server
whether this device was revoked, and got no answer because the wipe had already cleared the
credentials. `isDeviceRevoked` returns `false` when it cannot reach the server - **right for its own
question and wrong for that one**. It is written to gate a DESTRUCTIVE act (*should I erase
myself?*), where a transport failure must never be read as a verdict; the login was asking *may I
proceed?*, whose safe default is the opposite. One boolean, two questions, opposite defaults.

The login proceeded, reopened `CanariDB_<userId>` twenty-four milliseconds before the delete, and
`deleteDatabase` does not fail on an open connection - it BLOCKS. The message store survived on a
device its owner had declared lost, and every line but one reported a clean wipe.

**What is excluded is the wipe's DURATION, not a device identity.** Recognising the revoked
`deviceId` looks tighter and is not: between clearing `mls_device_id_<userId>` and deleting the
stores there is a window in which no identity exists to recognise, and a login entering it reopens
the database just the same. `ctx.setWipingRevokedDevice(true)` is therefore raised BEFORE step 1 and
released in a `finally` - causal rather than timed, one boolean read on every login, and incapable
of locking out a user who is legitimately re-enrolling, because the latch is gone by the time the
wipe returns. `loginImpl` names it in the refusal beside the three flags that were already named,
for the same reason they are: a swallowed login is otherwise indistinguishable from one that never
ran. Pinned by source guards in `offlineUnlock.test.ts`, which assert the ORDER - the thing that
broke.

#### And what the wipe hands over to decides whether the device ever leaves the page

The wipe finishing is not the end of the revocation - something has to take the person off a client
that no longer has an account. There are three call sites for `wipeRevokedDevice` and they do not
all have the same next step. The two inside `loginImpl` throw a `LoginFailure`, which is right: a
person is standing at the PIN gate, the modal is where an answer belongs, and `loginImpl`'s caller is
holding a submit open waiting for one. The third is the `device_revoked` push handler, and there is
no gate, no submit and nothing to retry.

It used the same seam anyway, and the callbacks make the consequence concrete. `ChatBackgroundService`
binds `onLoginFailed` to `onSavedPinFailed`, which sets `showPinModal = true`. So a revocation
reopened the PIN prompt on a device the line above had just returned to a fresh install: no PIN
registered locally, no device id, no session for the prompt to act on. Measured on production
2026-08-29, the client then stayed on `/chat` with no sidebar and no navigation for at least fifteen
seconds; what eventually moved it was the prompt's own attempt calling `POST /api/auth/refresh`,
being told `no canari_refresh cookie`, and reaching `handleSessionExpired` - the right destination,
arrived at by way of a failure, several seconds late.

`onSessionExpired` is that destination named directly. Its contract is an authentication loss rather
than a retryable error, and it is the one callback `sessionCb()` wires unconditionally rather than as
an override - `handleSessionExpired` clears the auth and navigates to `/login`. The localized message
the change drops was only ever shown in a modal the app abandoned two seconds later, so nothing a
user could read is lost. Pinned in `offlineUnlock.test.ts` by two guards on the handler's own text:
the handover comes after the wipe, and it is not the retry seam.

### A restore that comes back partial says so (2026-10-08)

A device that signs back in after a revocation, a wipe or a lost MLS store restores its conversation
ROWS from the local store and its MLS GROUPS from the persisted state, and the two can disagree: a
row restored as `active` promises that this device can read and write it. A user once reconnected
and got some conversations back and not others, with nothing saying which - the restore looked
complete, so nobody knew to act.

`measureRestoreShortfall` (`utils/chat/restoreShortfall.ts`) compares them at the source and returns a
typed `RestoreShortfall` (`expected`, `restored`, `missingIds`) or `null`. Only `active` non-channel
rows are OWED a group: `pending` rows already say they wait for a Welcome, so a backup restored on
another device reports nothing, and a row demoted by an earlier startup is not re-reported for ever.
`startSession` takes the measure BEFORE its lifecycle reconciliation demotes the rows (afterwards the
evidence is gone), logs `[ERROR] Partial restore: n/m ...` and `console.error`, and raises
`restore_shortfall` on the existing `mlsFatalError` banner (`MlsFatalErrorBanner`, Paraglide
`mls_error_restore_shortfall_text`, dismissible). No retry or repair was added: the demotion to
`pending` and the re-add that follow are the existing recovery, and this is only its report.


### The same erasure when the USER asks, and the three things the button never did

**REMOVED 2026-09-25, by the user's decision: a developer tool had no place under the sign-in
button.** The login page's "Reinitialiser l'appareil" link and `resetThisDeviceOnRequest`, its only
caller, are gone; `wipeDeviceToFactory` now has one caller, `wipeRevokedDevice`. What that button
taught - it asked nothing, told no server, and discarded the list of steps that failed - stays in
[durable-rules](../../durable-rules.md). A user-requested reset, if one ever returns, owes the
revoked path's order: declare the device gone, then `clearAuth()`, then the wipe.

### A sign-out ended the session on the server and left it live on the device - FIXED 2026-10-14

**Found on the Mi 9T bench of `1.2.7-alpha.2`, 2 of 2** (evidence:
`canari-harness/a1-bench/r1014-a127a2/cons-signin*.ndjson`). Tableau de bord > Deconnexion, then a
sign-in in the same process: the OIDC callback completed (`handleOidcCallback resolved`, `goto ->
/posts`) and nothing followed - no PIN gate, no vault restore, "Connexion en cours..." for four
minutes. Only a relaunch recovered.

**The timeline names the trigger.** The app returns from the sign-in browser and
`resumeConnectionImpl` reconnects the socket: `[A] refresh✗latched`, `Gateway inaccessible:
SessionExpiredError`, `[AUTH] Session expired - redirecting to /login.` - 1 s BEFORE the callback's
`got access_token`. It is NOT #1843's `connectivity.onReconnect` (that path is gated on
`isLoggedIn` and never names the gateway), and nothing on this path changed between `v1.2.6` and
`1.2.7-alpha.2`.

**Two things outlived the sign-out, and only together do they lock the next sign-in out.**

1. **The live session.** Every sign-out in the app - the dashboard, the navbar, the PIN gate, the
   platform gate, the identity-split notice, a dead session - is `clearAuth()` then `/login`. None
   reached the chat session, which the app shell owns: `logoutImpl` had had NO caller since the
   2026-04-09 navbar refactor. So `isLoggedIn` stayed true for a signed-out user, the foreground
   resume was still armed, and it reconnected a session whose credential the sign-out had just
   killed. When the callback won the race, the ghost session simply carried on with the new token -
   which is why this looked like it worked.
2. **`_loginInProgress` in `ChatBackgroundService`.** A login that SUCCEEDS never releases it (the
   `finally` releases it only when nobody is logged in). Once the reconnect set `isLoggedIn` false,
   every trigger that should have started the unlock (`afterNavigate`, the user-id effect) returned on
   that stale latch.

**The fix is one seam.** `clearAuth` calls a handler registered by the app shell
(`setSignOutHandler`) FIRST, before the access token is dropped - the teardown deregisters the push
token with it. The shell's `handleSignedOut` runs `endSessionImpl` (what `logoutImpl` was, minus the
erasures `clearAuth` already owns) and releases `_loginInProgress`. `endSessionImpl` acts only on a
session that is live, which also keeps the revocation wipe's own `clearAuth` from running a second,
flushing teardown. A dead session ending does not ask the server to deregister its push token: the
refresh latch already says the answer is a refusal. Tests: `stores/auth.test.ts` ("the sign-out
handler"), `composables/session/signOutEndsLiveSession.test.ts`, and
`composables/session/signOutTimeline.test.ts`, which replays sign-out, resume, second sign-out over
the real `clearAuth`, `endSessionImpl` and `resumeConnectionImpl`.

**Two things the adversarial review added (2026-10-14).** `endSessionImpl` releases the socket
(`pauseSocket`) BEFORE the teardown's final flush: the gateway does not close a socket when the
server revokes the session, and the teardown unregisters the state persister, so an open socket kept
decrypting and ACKing the leaving account's frames into memory that nothing would write. And the
shell's `_sessionExpiredHandled` - set by the first expiry, reset by nothing - is reset by the shared
`onMlsReady`, so a second expiry in the same process logs out instead of being swallowed.

**The MLS client leaves with its account (fixed in the same PR).** The client survived the
sign-out - nothing called `resetMls` - and `BaseMlsService.init()` returns at once on its cached
`initPromise` while `resolveDeviceId` hands back its cached id: account B signing in after A on the
same install ran on A's decrypted client and A's device id. The ghost session had masked it (B never
reached a login). Now `endSessionImpl` RETIRES the client (`composables/session/mlsHolder.ts`): the
holder lets go of it at once, so any later `ensureMls` builds a fresh one, and destroys it once the
teardown's final checkpoint has landed (`tearDownLiveSession` now returns that write, which never
rejects). `loginImpl` and `recoverPinImpl` `await ctx.whenMlsRetired()` before they touch MLS or read
the state, because that write is what they read. The SAME account signing back in therefore pays
one full state decrypt, as a cold start does - chosen deliberately over reusing a client whose
account the code cannot prove. The call service is rebuilt over the new client (`initServices` is
keyed on the client, not on "one exists"). Possibly the cause of the P3 "switching accounts on one
iPhone install" in [backlog](../../backlog.md), not proven - and not the only one: the device-key
vault, which B used to sign in on with A's key, now names its account
([the vault names its account](#the-vault-names-its-account---fixed-2026-10-14)).
Test: `signOutTimeline.test.ts`, "a sign-out retires the account with its MLS client".

**The retirement always settles, and every reader of the disk waits for it.** `mlsHolder.retire`
catches a final write that rejects and a destroy that throws, because a login awaits that chain and
a rejection left it - and `isLoginInProgress` - stuck. The "forgot PIN" reset
(`resetDeviceAsFreshImpl`) waits too: it runs from the next sign-in's PIN gate, and a late write
would put back, under the old key, the state it deletes. There is no clock on the wait: it ends when
the local write does (a Mi 9T checkpoint has been measured at 48 s), so a slow write is a slow
"Connexion en cours", never a stuck one. Tests: `mlsHolder.test.ts`, and
`accountSwitchLateFlush.test.ts`, which replays A's held write, B's sign-in and the late landing
over the real `useChatSession` (client, call service, persister, hooks, encrypt worker).

**A late final flush no longer removes the NEXT session's persister.** The teardown removed the
persister, its lifecycle hooks and the encrypt worker in the flush's `.finally`, unconditionally -
so a next login that registered its own in the meantime lost them. Both removals now name the
persister this session registered (`unregisterMlsStatePersister(owner)`,
`uninstallMlsStatePersisterLifecycle(owner)`) and skip one that is not current; the shared worker is
disposed only when no session has registered since; and installing hooks for a NEW persister replaces
the old ones instead of being skipped by a stale "installed" flag. The login's wait above already
orders this; the guards make it hold without relying on that order.

**A sign-out during a login in progress stops that login** - see
[the section below](#a-sign-out-during-a-login-in-progress-completed-the-login---fixed-2026-10-18).

**What a sign-out still keeps, deliberately**: `mls.bin`, the message database and the device-key
vault ("deconnecter seulement, garder l'etat", see `handlePinSignOut`). So a device signed out with
"Rester connecte" ticked unlocks WITHOUT its PIN after the next sign-in of the SAME account (another
account never sees that slot - [the vault names its account](#the-vault-names-its-account---fixed-2026-10-14)) - the
vault was never cleared by any live path, `v1.2.6` included. Whether a sign-out should end "Rester
connecte" is a decision for the user, not a defect of this fix.

### An account deletion wipes THAT account's local database and vault slot (WP-DEL-LOCAL, 2026-10-18)

A sign-out keeps the local state on purpose; a deletion is the one exit after which nobody can open it again. Decided by the user 2026-10-18: never `wipeDeviceToFactory`, which takes other accounts' state too.

- **WHOSE DATA GOES IS THE TOKEN'S ANSWER, NEVER THE PAGE'S.** `deleteMyAccount()` returns the `sub` of the bearer the server ACCEPTED for the `DELETE` (`apiFetch`'s `onAuthorization`, the retry's token after a 401). `decideDeletedAccountWipe(sub, currentUserId())` (`utils/accountLocalWipe.ts`) ALWAYS names the token's subject: `wipe` when it is also the account on screen; `wipe-other-account` (logged at ERROR) when it is not. The case that exists for: this tab shows A, a second tab signed in as B rotated the cookie, the server deletes B - wiping "the account on screen" would destroy A, who still exists, while B is CERTAINLY gone and nothing else would ever name its data again, so B's goes and A's is never touched (and this realm's handles, which are A's, are not closed for it). `no-subject` and `unwipeable-id` wipe nothing, at ERROR.
- **A DURABLE MARKER, `canari_deleted_account_wipe_pending:v1`** (a list of ids), is written after the 204 and before the first local deletion, cleared only when every step succeeded, and resumed at the next start (`startDeletedAccountGuards` in `+layout.svelte`). It does not close this realm's handles, which would cut another account's live session.
- **THE RESUME IS SERIALISED AGAINST SIGN-IN, not by running first.** It is not awaited at `onMount`, so a leftover marker for X could otherwise meet X (the same MiConnect subject, a new account) signing back in - and delete `CanariDB_X`, the device id and the vault slot under the NEW live session. So `resumePendingDeletedAccountWipes(accountLiveness)` first waits for any sign-in in flight (`accountLiveness.whenSignInSettled`: a refresh, or an OIDC callback, both counted in `stores/auth.ts`), then asks again BEFORE EVERY DESTRUCTIVE STEP: X signed in AGAIN - **a token that landed in this process names it** - stops the wipe and drops the marker at ERROR - its data is the live account's now; a NEW sign-in in flight stops it and KEEPS the marker for the next start, since whose it is cannot be known yet. What a check cannot close: a sign-in starting during one step's own await (an IndexedDB delete) - a session opening `CanariDB_X` then queues behind the delete and opens an empty database, losing only the deleted account's rows.
- **"SIGNED IN AGAIN" IS PROVEN BY A TOKEN, NEVER BY THE SAVED USER** (P2-1 of the third review of #2023). The first `accountLiveness.isLive` also answered yes when `canari_saved_user` named X. A kill between the marker and `clearAuth()` leaves it naming X, so the next start - always an offline cold start - dropped the marker and kept the data for ever. Access tokens live in memory only, every resume runs in a process started after the 204, and the server refuses a refresh for a deleted account, so a token naming X can only come from X signing in again.
- **A TOKEN IS ENOUGH ONLY BECAUSE THE TOKENLESS ENTRIES ARE CLOSED** (fourth review of #2023). A marker can outlive the deletion (a refused case collision keeps it for ever, a delete another tab blocked, a native failure), and narrowing `isLive` to a token removed the protection from two cases: **(A)** the subject comes back as a NEW X after the erasure, then a second tab resumes before its own refresh, or a native cold start opens X offline - no token, `isLive` false, and the resume deletes the new account's `CanariDB_X`, device id, keystore entry and vault slot under a live session; **(B)** the offline unlock of the deleted X races the resume and its session re-creates `CanariDB_X` and per-account keys after the steps ran. Two rules close them, both in `utils/deletedAccountMarker.ts` (the marker's own module, so the auth store and the login read it without loading the store stack): **a successful OIDC callback for X drops X's marker** (`forgetDeletedAccountOnSignIn`, first thing after the response) - `users.id` IS the subject and the server refuses it with `ACCOUNT_ERASURE_PENDING` until the erasure completed, so a callback that succeeds is a new account; and **every login refuses an account deleted here before it opens a store** (`isDeletedAccountHere` at the top of `loginImpl`'s `try`, before the landing preview's `getStorage`, the MLS state lookup and `getToken`), with `LoginFailure('account_deleted', m.auth_account_deleted_here())` shown at the PIN gate: "this account was deleted, sign in online". `isDeletedAccountHere` is the marker OR a LIVE wipe (the one right after the DELETE) started in this process, so an unlock that read its key before that wipe finished is still refused once the marker is gone. **A resumed wipe sets no in-process flag** (fifth review of #2023): resumed from a stale marker in two web tabs, tab A's flag would outlive a sign-in from tab B - whose `forgetDeletedAccountOnSignIn` clears only its own process - and refuse the new account in tab A. The cost, accepted: an offline unlock that read its key before a RESUME finished, and asks after it dropped the marker, is not refused. Two more tokenless readers are closed the same way: the PIN gate asks neither a salt nor a recovery for `account_deleted` (`applyPinFailure`), and the posts page's `ConversationsMiniPanel`, which opens the SAVED user's store with no login, opens nothing for an account `isDeletedAccountHere` names - after a kill before `clearAuth()` the saved user is still the deleted X. The resume also re-reads the marker before every step and stops (`no-longer-owed`) when another tab's callback dropped it. Entries covered: every session goes through `loginImpl` - the saved-user restore (vault on web and Tauri, keystore with or without a prompt), the PIN gate and the PIN recovery, and a follower tab, which reloads and logs in on its own; there is no cross-tab adoption of a session. The online paths need no rule: a refresh for the deleted X is refused (`SessionExpiredError`).
- **Every other tab is told** (`BroadcastChannel` `canari-account-deleted`, `utils/deletedAccountGuards.ts`): a tab signed in as the deleted account runs **`clearAuthLocally()`** - its identity and token only, **no `POST /api/auth/logout`, no cookie flush, no native credential**: those are one per origin, the deleting tab already revoked its own session, and by the time the notice lands the cookie may belong to an account signed in since, which a second logout would end for nothing. It then waits for its MLS checkpoint, closes its stores and goes to `/login`. A tab signed in as anyone else ignores it. A delete still deferred by such a tab is a reported failure, finished by the resume.
- `wipeDeletedAccountImpl` (sessionAuth.ts) first awaits `whenMlsRetired()`, so the sign-out's final checkpoint cannot recreate what is deleted. The wipe then closes this account's handles, deletes `CanariDB_<id>`, `CanariDBOutbox_<id>` and `CanariDBMls_<id>` by exact name, and on Tauri asks `delete_user_database` to remove `canari_<id>.db` plus `-wal`/`-shm` **under `app_config_dir()`, the directory `tauri-plugin-sql` 2.4 really opens it in** (`app_data_dir()` is the same directory on Windows and macOS and a different one on Linux, where the first version removed 0 files and said "removed"). When a store was open for the account in this run, finding no file is an ERROR, not success.
- It also deletes that account's platform-keystore entry (`mls_device_key_<id>_<deviceId>`, biometric enrolment) - the entry only, the per-install "configured" flag stays for the other accounts - and its per-account `localStorage` keys, through ONE list: `ACCOUNT_KEY` in `utils/accountLocalKeys.ts`, which every writer, reader and sweeper of such a key builds it from - send-ratchet ledger, device id, key-change epoch, archived conversations, the history ledgers, the not-ready registry, the feed-store epoch, the device names, the last-active stamp (and its native `session-meta.json` mirror, cleared by its own step), the legacy `mls_autosave_<id>`, the salon read marks, the `canari_graine_history_held_nothing:v1:<id>` record of #2027, and **`canari.salon-unsent.<id>`, the PLAINTEXT of unsent salon messages**. The keystore alias has ONE TypeScript builder, `keystoreAlias()`, used by all six callers (the Rust side spells the same shape in `commands/mls.rs` and `commands/push.rs`). **`accountLocalKeys.guard.test.ts` reads the source and fails** on a listed key's literal spelled outside the list, on an alias built inline, on a storage call whose key is built inline, and on a key-shaped literal interpolating a user id - the review of #2023 found nine keys the first list missed, and nothing at run time can tell a forgotten key from a deliberate one. A keystore entry that survived keeps its device id, so the resume can still name it.
- **THE PUSH SIDE'S PLAINTEXT GOES TOO, BY OWNER.** `delete_user_push_files` (`commands/push.rs`) removes `outbox_pending.ndjson` (unsent `AppMessage` protos in the clear), `fcm_message_cache.ndjson`, `read_watermarks.ndjson`, `outbox_sent.ndjson` and then `push_context.json` (`userId`, `deviceId`, the bearer `pushToken`) - **only when `push_context.json` names the deleted account**, the one fact that says whose the NDJSON files are. It touches nothing when the context names another account (signed in since), and nothing when it is absent, unparseable or names nobody, logged. The context goes LAST, so a failure keeps the proof for the resume. The read, the check and the removals hold `PUSH_CONTEXT_LOCK`, which every writer of `push_context.json` takes too (`store_push_context`, `store_device_identity`, `set_push_context_locale`): a new sign-in storing its context during the deletion used to be removed on a proof about the previous bytes; it now waits and survives (a sync Tauri command is not serialised by the runtime). `graine_seeds.json`, `mls.bin` and the push secret are not touched.
- **ON iOS THE APP GROUP CONTAINER GOES ON THE SAME PROOF (2026-10-19).** Two writers put the deleted account's data there and neither ever deletes: `CanariMirrorPushStateToAppGroup` (`canari_push.mm`) copies `push_context.json` at `didBecomeActive` / `willResignActive` and SKIPS a missing source, and the Notification Service Extension writes its decrypted `fcm_message_cache.ndjson` there. So the bearer `pushToken`, `userId` and `deviceId` outlived a deletion at rest, readable by the extension. `delete_user_push_files` now removes every name of the account list (the four NDJSON files and `push_context.json`) from the container too, before the app's own context - a copy that will not go is a failure, so the proof stays for the resume. No container is logged at ERROR and returned, after the app's own files went: the mirror reaches the container through the same entitlement, so nothing was copied into one this call cannot reach. Deletion removes explicitly rather than the mirror deleting a destination whose source is gone, because the extension's cache has no source to mirror and the mirror next runs only when the app leaves the foreground. The mirror cannot copy the context back mid-deletion: the command is synchronous, and on iOS a synchronous command runs on the main thread the mirror runs on (read from wry 0.57 / tauri 2.12, not observed). **Owed on the iPhone 12** ([device-verification](../../device-verification.md)): this branch is `#[cfg(target_os = "ios")]` and nothing on a Windows host or a pull request's CI compiles it.
- **THE LEGACY PLAINTEXT CONVERSATIONS (`canari_conv_<id>_<contact>`, `migration.ts`) ARE SWEPT ONLY WHERE PROVEN.** `_` is in the id allowlist, so the prefix `canari_conv_a_` also opens account `a_b`'s keys. `legacyConversationKeysIn` takes a key as `<id>`'s only when the rest after the prefix holds no `_`: any account whose id starts with `<id>_` writes a rest that always holds one. A rest with a `_` (a contact name carrying one, or another account's key) is kept, and the wipe logs how many at WARN. The guard's rule 4 also catches a concatenation (`'x_' + userId`, `PREFIX + userId`), the shape that hid this key.
- **TWO IDS THAT DIFFER ONLY BY CASE SHARE STORAGE, SO THE WIPE REFUSES THEM.** Three keys lower-case the id (archived conversations, salon unsent, salon read marks) and `canari_<id>.db` lives on a case-INSENSITIVE filesystem on Windows and macOS: wiping `Abc` would take `abc`'s unsent texts and database. `caseCollidingAccountIdsIn` reads the id-naming keys back, and when another stored id case-folds to the deleted one the wipe is refused at ERROR, naming the twins, once per start, and stays owed - never a guess at whose rows are whose.
- **A LOST 204 WIPES NOTHING, AND THAT IS ACCEPTED, NOT DETECTED.** When the server committed the deletion but the answer never arrived, `deleteMyAccount()` throws (a transport failure, or a deadline), the error is shown, no marker is written and the session continues until its next refresh answers 401 - the ordinary expired-session path. Detecting it would mean reading "this account was deleted" out of a 401 that also means "this session expired", a distinction the server does not carry; guessing it from the refusal is the learning-by-failing the rules forbid. The cost: that account's rows stay under its device key, unreadable without its PIN, until the next device reset - and a retry of the deletion (a 401 or 404 then) does not wipe either. Owed only if a server signal ever separates the two.
- **THE ID GUARANTEE.** The user id is the MiConnect `sub`, a `varchar(255)` copied as it comes: a UUID, a hash, a username or an email. Both sides accept exactly `[A-Za-z0-9_.@-]{1,255}` (`isWipeableAccountId`, `is_wipeable_account_id`) and REFUSE anything else, loudly, rather than normalise it: the stores were created under the raw id, so a normalised one names another file, and an id holding `:` would let the prefix keys `history_*:<id>:` reach another account's.
- LEFT ALONE, deliberately: every other account's database, slot and keys, the in-app log, the preferences, and `mls.bin` (one file per install that may hold another account's state: [backlog](../../backlog.md), the shared `mls.bin` P3).
- Tests: `accountLocalWipe.test.ts` (the resume against a sign-in landing before and during it, the case collision, the whole key list), `accountLocalKeys.guard.test.ts`, `auth.deletedAccount.test.ts` (`clearAuthLocally` sends no logout; `accountLiveness`; scenario A - the callback drops the marker and a tokenless resume then wipes nothing; `isDeletedAccountHere` holds after the LIVE wipe finished, and a resumed wipe leaves no flag), `pinFirstSetupRefuted.test.ts` (`account_deleted` asks no salt and no recovery), `ConversationsMiniPanel.deleted.svelte.test.ts`, `offlineUnlock.test.ts` (scenario B - the refusal precedes every store opener and `getToken`), `deletedAccountGuards.test.ts`, `user.deleteMyAccount.test.ts`, `apiFetch.test.ts` (`onAuthorization`), three Rust tests in `commands/storage.rs`, eight in `commands/push.rs` (`delete_user_push_files_tests`, App Group container included, `push_context_lock_tests`). **What only a device proves:** the SQLite file and the keystore entry are really gone on Android and iOS (where `app_config_dir()` was never read on hardware), and a second WebView tab is not a thing a phone has.

### One sign-out sent two logouts, and the vault logged the user back in during it - FIXED 2026-10-17

**Found on the Mi 9T bench of `1.2.9-alpha.7`** ([device-verification](../../device-verification.md),
evidence `canari-harness/a1-bench/r1017-a129a7/signout.json`). One tap on "Se deconnecter": `[A]
clear`, `[LOGOUT] MLS client retired`, then **`[PIN] Device key restored from PinVault - auto-login`
17 ms later**, its `refresh->` racing the logout, `refresh✗401`, `[AUTH] Session expired - logging out
and redirecting to /login?returnTo=%2Fdashboard`, a second `clear` and a second `POST
/api/auth/logout`. There was no page reload: the `Initialised in TAURI mode` line is the shell's
user-id effect calling `initServices` before `startLoginFlow`.

**The cause is an ORDER in `clearAuth`, not the vault.** The sign-out handler sets `isLoggedIn` false
synchronously, but `clearUserLocally()` ran LAST, after the awaited logout. For the whole round trip
the shell saw "a saved user, nobody logged in" - exactly what its unlock triggers (the user-id
`$effect`, `afterNavigate`) start the unlock on - and the vault slot of that user unlocked without a
person. Its refresh met the revocation, and `notifySessionExpired`, gated on a saved user, announced
it.

**The fix is the order, so nothing has to be latched or timed.** `clearAuth` drops the local identity
right after the handler, BEFORE its first `await`. No unlock can start (every trigger needs a saved
user), and a 401 met during the sign-out announces nothing (`notifySessionExpired` is silent with no
saved user, as it is during a login).

**One path could put the identity back, and the review found it.** `_doRefresh` restores the user
from a token's `sub` when none is saved (the Android process-kill branch). Under the old order the
final `clearUserLocally()` wiped whatever a racing refresh re-saved; with the identity cleared first,
a refresh answered 200 during the sign-out - one in flight when it began, or one asked for after the
token was dropped - re-saved the user and the token: the same vault unlock, 401 and second sign-out.
The "superseded by a sign-in" guard could not see it (it needs a live `_accessToken`, which the
sign-out had just dropped). **Closed by a sign-out GENERATION, not a clock**: `clearAuth` increments
`_signOutGeneration` and is counted in `_signOutsUnderway` for its whole run. A refresh asked for
meanwhile is not sent (`refresh✗not sent - a sign-out is in progress`); one already in flight
compares the generation it captured before its send, at its answer, after its body and after its two
writes, and DROPS the answer (`refresh✗answer dropped`) - no identity, no token, no stored rotation,
no verdict announced.

**The refusal holds until the LAST sign-out under way ends** (second review): sign-outs overlap - a
double tap, a session expiry during the PIN gate's or the navbar's sign-out - and a single flag that
the FIRST finisher lowered let a refresh go out while the other was still revoking. That refresh
captured the current generation, so nothing dropped its answer. Hence a count, not a flag.

**Both refusals throw `SignOutInProgressError`, NOT `SessionExpiredError`** (classified at the throw):
that type means "the server proved the session dead", and its consumers answer with a logout and a
redirect - a second sign-out. Every consumer that branches on `SessionExpiredError` was enumerated,
and the ones that would act on it stop quietly instead: `loginImpl` (its `getToken` catch and its
outer catch, which would otherwise also have forgotten this account's vault slot),
`attemptReconnectImpl` and `openGatewayConnection` (no `goto('/login')`, no backoff retry),
`promoteOfflineSession` (not "network unreachable"), and `toUiActionError` (no error toast).
`apiFetch` and `fetchUpload` already rethrow a refresh failure as it came.
Tests: `stores/auth.test.ts`, "the local identity at sign-out" (each fails without the fix it names:
the order, the generation, the count), and one per consumer, each failing without its branch:
`offlineUnlock.test.ts` (both `loginImpl` catches), `signOutInProgressReconnect.test.ts`,
`startGatewayHandshake.test.ts`, `promoteOfflineSession.test.ts`,
`useChannelWorkspaces.svelte.test.ts`. `stopPushService` reads `currentUserId()` synchronously and
relies on running from the handler, before the identity goes; a comment there says so.

**The contract, unchanged:** a deliberate sign-out keeps the vault slot (see above), and it never
unlocks it again by itself. Only a NEW sign-in of the same account reopens it without the PIN.
**What only a device reading proves**: that one tap sends ONE `POST /api/auth/logout`, logs no
`[PIN] Device key restored` and no `[AUTH] Session expired` after `[A] signout requested by the
user`, and lands on `/login` (not `?returnTo=`), on the Mi 9T on the vault path. The ordering is
proven here; the Svelte effect scheduling on the real WebView is not.

### A sign-out during a login in progress completed the login - FIXED 2026-10-18

**The defect.** A login can run ~12 s inside the native decrypt of `mls.bin` (Mi 9T). A sign-out in
that window found no live session (`isLoggedIn` still false), so `endSessionImpl` stopped nothing,
and the login then completed: `isLoggedIn` true for a signed-out user, its gateway socket open (the
handshake starts beside the state load). A sign-out AFTER `setIsLoggedIn(true)` did end the session,
but the login kept running past it - its next awaits opened the gateway, installed the history-probe
sender and started the watchdogs for the account that had left.

**The fix is the sign-out GENERATION, not a flag or a clock.** `stores/auth.ts` exports
`signOutGeneration()` (the `_signOutGeneration` every `clearAuth` increments first). `loginImpl`
captures it before its first await and re-reads it right after EVERY await of its main sequence
(`stopIfSignedOut(stage)`): a sign-out can only run while the login is suspended, so nothing after a
re-read can act for a signed-out account. The one that closes the defect sits after the final
`getToken` and before `setIsLoggedIn(true)`, with no await between them. A re-read inside a block
whose `catch` swallows errors is placed after that block.

**The stop is a TYPE, `LoginStoppedBySignOutError(stage)`** (`loginErrors.ts`), and the outer catch
treats three shapes as that one outcome: the refresh refused during a sign-out
(`SignOutInProgressError`), the login's own re-read, and a `SessionExpiredError` met after a sign-out
began - that sign-out's own revocation, which `onSessionExpired` would have turned into a second
sign-out. **Any error thrown once a sign-out began is that sign-out's** (review of #2067): an await
that REJECTS after it never reaches a re-read - the PIN check meeting the revoked session (401), a
restore reading the store the teardown closed (`TypeError`) - and took the failure path (a PIN
error over the sign-out, `clearDeviceKey`). The catch reads the generation, by type and code, never
by message; the one exception is this login's own revocation wipe (`device_revoked`), which signs
out on purpose. The `getToken` catch hands any failure after a sign-out over the same way. No error
is shown, no callback runs, the vault slot is kept, and the line names the stage
(`[INIT] Login stopped - the account signed out during it (after mls-init-and-storage).`). A
revocation answer read after a sign-out wipes nothing: the next login asks the server again - and
no wipe may START after a sign-out, because it waits for the MLS retirement that sign-out chained on
this very login (a re-read sits right before both wipe calls). The session's identity and the
tab-leader callback are set only after the first re-read.

**Two logins can overlap** - the PIN gate clears `isLoginInProgress` to start a sign-in beside a
login still decrypting (`handlePinSubmit`) - **so a stopped login releases only what it owns.** A
sign-out during a login RETIRES the login's client on that login's end (`endSessionImpl`, not-live
branch: `retireMls(loginInFlightSettled)`): the holder lets go at once, the next sign-in waits on
`whenMlsRetired` and builds its own client, and the stopped login's client is destroyed once that
login has paused its socket. The login flag is cleared only by the login that set it last
(`loginFlowOwner`), so the stopped login's exit never releases the newer one's flow. The cost,
accepted: a sign-in started during a stopped login's decrypt waits for that decrypt to end.

**That wait is bounded by the SIGN-OUT, not by a clock** (second review of #2067). Its network
awaits - the refresh, the PIN salt, pin-check, the revocation question - have no deadline of their
own, so a hung one held the next sign-in, the forgot-PIN reset, `recoverPinImpl` and the deletion
wipe behind it. The sign-out now ABORTS the login in flight (`loginInFlightAbort`, aborted in
`endSessionImpl`): the salt and pin-check requests carry its signal, and every network await goes
through `untilSignedOut(work, stage)`, which rejects at once with `LoginStoppedBySignOutError` -
the stop path, never a transport failure or a logout. The local MLS decrypt is NOT cancelled: the
next login opens the same state. A key proven after the sign-out is not installed either. An
aborted request is not a transport failure: `fetchOrUnreachable` passes an abort its caller asked
for through as it came, with no `could not be reached` line. **The login's OWN revocation wipe is
exempt** (third review): its `clearAuth` reaches `endSessionImpl` like any sign-out, and aborting
the login doing the wipe turned a revoked device on the PIN path into a silent stopped login with a
false `wipe FAILED` line. `startOwnWipe` withdraws the login from `loginInFlightAbort` first, so its
outcome stays `device_revoked`.

**A revocation wipe that fails after its own `clearAuth`** (a blocked factory reset) is a sign-out
of the login's own making with a code other than `device_revoked`, so it lands on the stop path - and
is accused first, at ERROR (`[SECURITY] The revoked-device wipe FAILED - local data may remain`).

**What a stopped login releases: its socket, then its MLS client** - the same two steps as
`endSessionImpl`, through the same primitives (`pauseSocket`, the holder). The client is held by
NAME: `ctx.resetMls(client)` destroys it only while the holder still holds it, because after a
sign-out of a live session the holder has already retired it, and the next sign-in may have built
its own since (`MlsHolder.reset(only)`). A handshake still in flight is released when it settles.
Nothing else needs undoing: before `setIsLoggedIn(true)` the login registers nothing global, and
after it the sign-out's own `endSessionImpl` has torn the session down.

Tests: `signOutDuringLogin.test.ts` runs the real `loginImpl`, `clearAuth` and `endSessionImpl` with
the init and the gateway held by deferred promises - a sign-out during the decrypt, and one after
the session went live, a restore rejecting after the sign-out, a PIN check answered 401 after it,
a sign-in started beside a stopped login, a hung pin-check the sign-out cancels, and a failed
revocation wipe (each fails without its fix); `offlineUnlock.test.ts`
and `landingPreviewOrder.test.ts` pin the catches;
`mlsHolder.test.ts` the named reset.

**What a sign-out does NOT keep: the saved community list (2026-10-14).** The rail and salon rows
the last listing drew are saved per account (`canari_workspace_snapshot:v1:<userId>`,
[community-open-budget](../community-open-budget.md#f1-f3-built-2026-10-14)) so the next launch
draws them before the network. `clearUserLocally` erases every such slot at EVERY sign-out, with or
without "Rester connecte", and `saveUserLocally` does on a change of account - the feed verdict's
rule. Why not keep it like the vault: the vault saves a PIN, which a member must type to rebuild it;
the list saves only the first listing after the next sign-in, which needs the network anyway. A
copy of one account's communities waiting on a signed-out device is a disclosure with no gain. The
in-memory list goes too (`forgetAccount` in the sign-out handler), which it never did before.

## Mobile unlock flow (Tauri)

Driven by `startLoginFlow()` in `components/layout/ChatBackgroundService.svelte`.

**First sign-in** — OIDC, then the PIN sheet (with the "stay signed in" opt-in). Immediately after
the PIN is accepted, `BiometricEnrollSheet` offers biometric unlock, but only if the hardware is
available, biometrics are not already configured, and the offer was not previously declined. It
cannot be offered earlier: the device key does not exist until the first PIN entry. Declining is
permanent (`canari_biometric_prompt_dismissed` in `localStorage` **and** the native flag
`biometricPromptDismissed`, so it survives an Android process kill).

**Later sign-ins** — with biometrics enrolled, `BiometricBottomSheet` opens alongside the OS prompt.
On failure or cancellation there is no silent fallback: the PIN sheet opens, keeping the "use
fingerprint" button so the prompt can be retried (the button is hidden when no biometric is
usable). With a stored key and no biometrics, login is silent; the PIN sheet only appears if it
fails.

`BiometricBottomSheet` is rendered once and serves both flows; the enrolment variant is raised from
`enrollBiometricImpl` through the `biometricPrompt` store, so the post-login offer and the Settings
toggle behave identically.

### Two flags gate the biometric branch, and both must answer

`startLoginFlow` offers biometrics only when `BiometricService.isConfigured()` (the user opted in)
**and** `BiometricService.isKeyPresent(alias)` (a key really exists under
`mls_device_key_{userId}_{deviceId}`) both say yes. The second check exists so a reinstall - flag
restored from the native store, keystore empty - does not raise a prompt that could only fail.

A false answer from either is not a soft degradation: `biometricAttempted` stays false, the sheet
never opens, and `biometricConfigured = biometricAttempted` also hides the "use fingerprint" button
on the PIN modal. Biometrics become unreachable with nothing logged. That is precisely what
happened while `isKeyPresent` invoked a plugin that did not exist (see below), so it now logs its
failure instead of returning a bare `false`.

### The system biometric prompt

`BiometricService` raises it through `authenticate(reason, options)` from
`@tauri-apps/plugin-biometric`. Only `reason` is obvious from the signature, and it is **not** the
whole prompt - the plugin fills the rest from its own English defaults:

| Field | Passed by Canari | Plugin default if omitted | Shown on |
|---|---|---|---|
| `title` | `auth_biometric_prompt_{enable,disable}_title` | `"Fingerprint Authentication"` / `"Face Authentication"` (internal `biometryNameMap`) | Android |
| `subtitle` | *deliberately not passed* | none | Android |
| `reason` | `auth_biometric_desc` | none | Android (as description), iOS (`localizedReason`) |
| `cancelTitle` | `common_cancel_button` | `"Cancel"` | Android button, iOS `localizedCancelTitle` |

So a prompt whose `reason` is carefully localized still showed an English title and button. Shared
options live in `biometricPromptOptions()`; the title differs per call site.

**Passing every field the API accepts is not the same as filling the prompt well.** Android stacks
`title`, `subtitle` and description and then adds its own "touch the sensor" hint underneath, so
supplying all three put four lines on screen saying the same thing three ways. The `subtitle` was
dropped in v0.11.6: the title names the action, `reason` asks for the confirmation, and the OS names
the gesture. `reason` is also the *whole* prompt on iOS, so it has to stand alone - which is why it
is the generic `auth_biometric_desc` - a bare "confirm your identity to continue" - rather than a
restatement of the title, and why `auth_biometric_prompt_{enable,disable}` were deleted.

Wording across these strings names no modality. There is no Face ID on Android and no fingerprint on
a Face-ID-only iPhone, so a string offering "fingerprint or Face ID" was wrong on every device for
one half of its text; the catalogue now says "biometrics" and lets the OS prompt name the actual
sensor. The one exception is `auth_biometric_no_fingerprint_android`, Android-only by construction.

### The keystore unlock sheet is a second prompt, localized differently

The **keystore** plugin raises its own sheet, and only one command does: `get_key_bytes`, when
biometric mode reads the device key back. It runs in a native process with no access to the
Paraglide catalogue and no notion of the active locale, so its text cannot be resolved where it is
displayed - it travels down the call instead:

```
keystoreUnlockPrompt()            biometric.ts, the only place the strings are assembled
  -> invoke('initialiser_mls', { opts: { biometricPrompt } })
  -> InitMlsOptions              commands/mls.rs
  -> PluginDeviceKeyStore::with_prompt()
  -> GetKeyBytesRequest          flattened onto the wire: title/subtitle/cancelTitle/reason
  -> BiometricPrompt (Kotlin)  |  LAContext (Swift)
```

Every field is optional and each native side falls back to the French literal that shipped before
(`DEFAULT_UNLOCK_TITLE`, `kBiometricReason`, ...): a translation that fails to arrive must degrade
to the previous wording, never to an unlock that cannot happen. `reason` is iOS-only -
`BiometricPrompt` has no equivalent - and `title`/`subtitle` are Android-only. Four languages and
no compiler between them, so `services/keystorePrompt.test.ts` reads the Rust, Kotlin and Swift
sources and fails when a field is renamed or a literal creeps back into the builder.

The plugin used to carry a second, older API alongside this one - `store`/`retrieve`/`remove`, a
single secret under the hardcoded alias `unime_dev`, inherited from the UniMe sample it was forked
from. It had no caller in either the JS or the Rust layer and was deleted in v0.11.6, together with
the npm guest bindings (`@impierce/tauri-plugin-keystore`) that were its only published entry
point. The plugin now exposes exactly the four `*_key_bytes` commands.

### Calling the keystore plugin from JS

Two things must line up, and no compiler checks either:

| | Correct | Wrong, and silent |
|---|---|---|
| Prefix | `plugin:keystore\|…`, from `Builder::new("keystore")` | `plugin:app.tauri.keystore\|…` - that is the **Android class** id given to `register_android_plugin`, and resolves no plugin |
| Command | snake_case Rust fn name, e.g. `has_key_bytes` | the Kotlin/Swift method name, e.g. `hasKeyBytes` |
| ACL | listed in the plugin's `build.rs` COMMANDS **and** granted in `permissions/default.toml` | absent - the IPC boundary refuses the call although the Rust fn exists |

Build the identifier with `keystoreCommand()` from `services/keystoreCommands.ts` rather than
writing the string; `nativePluginCommands.test.ts` reads the Rust sources and fails CI when a name,
the handler registration, the ACL array or the default permission set drift apart.

`has_key_bytes` never prompts: Android reads SharedPreferences only, iOS matches keychain
attributes without decrypting (it tests the background item first, which carries no access
control, then the primary one with `kSecUseAuthenticationUISkip`).

## Offline unlock

A cold start with no network used to be unable to open the app at all. The blocker was never the
PIN - it was `getToken()`. The access token lives in memory only, so every cold start goes to
`POST /api/auth/refresh`, and offline that `fetch` rejects before anything local is even read.
Meanwhile a complete encrypted history sits on the device, perfectly readable.

**Only the paths that already skip the server PIN check may unlock offline**
(`offlineCapable = isBiometric || isVaultLogin` in `sessionAuth.ts`). That is the whole security
argument, and it is not a convenience choice: on those two paths the platform keystore or the
encrypted device-key vault *is* the authentication factor, and no server answer is part of the
decision - online or offline. So an offline unlock verifies everything an online one verifies.
Nothing is skipped, and nothing is deferred.

The PIN path is deliberately excluded. Its at-rest key derives from a per-user salt only the server
holds (`GET /api/mls/security/pin-salt`), and that salt is never cached. Caching it is what would
turn a 4-character PIN into an offline-bruteforceable secret against `mls.bin`, so a PIN user with
no network still gets the honest `auth_server_unreachable`. `offlineUnlock.test.ts` pins this.

| Signal | Meaning | Offline unlock |
|---|---|---|
| `SessionExpiredError` (HTTP 401/403) | The server was reached **and refused us** | Never. Logs out. |
| Any other `getToken()` rejection | Transport failure - the server said nothing | Proceeds on the two capable paths |

That distinction is the rule the whole feature rests on: **a status code is an answer, a transport
failure is not**. `_doRefresh` separates them at the source, and `connectivity.svelte.ts` keeps the
two facts apart for everyone else (`navigator.onLine` is optimistic - a captive portal reports
`true` - so `isOffline` also requires that the last call actually reached the server).

An offline session sets `authToken = ''` and `isOfflineSession = true`, and login then skips the
gateway connect, the push registration, group discovery and **both watchdogs**. The watchdogs are
the harmful part: left running, the connection watchdog would schedule a reconnect every tick
against a network that is not there, and an offline session holds `authToken = ''`, so the handshake
has nothing to carry - **every attempt is known-futile before it is made**, which is the one case
where not retrying is the right answer. `promoteOfflineSession` starts all of it once a token
exists.

### The pause/resume pair, and why an asymmetric one goes quiet

`pauseConnectionImpl` stops the connection watchdog, the sync watchdog and any pending reconnect
timer on every background - correct on mobile, where the OS is about to freeze or kill the process.
The resume side has to give all of it back, and it did not: `resumeConnectionImpl` only attempted a
reconnect, and the mobile lifecycle handler in `ChatBackgroundService.svelte` did not even call it,
reaching for `attemptReconnect` directly. The watchdogs are armed exactly once, at login
(`sessionAuth.ts`) or on `promoteOfflineSession` - so **after a single background/foreground cycle a
phone had no timer left that could notice a dead socket.**

Measured on hardware 2026-08-10 (A1, prod): parked on `/chat` with the "En attente de connexion"
banner up, **zero reconnect attempts in ~20 minutes of logcat** while HTTP kept working throughout
(`[API] <- 200 GET /api/presence`), then `Reconnecting... -> [WS] Connected` **330 ms** after the
wifi was cut. The socket had been dead since some earlier outage on a guest network that let HTTPS
through; nothing in the client was still asking. The user's own report - "pourquoi est-on en attente
de connexion ?" - is what started the measurement.

`resumeConnectionImpl` is the single resume seam: it resets the backoff, re-arms both watchdogs
(both are idempotent) and only then reconnects if the socket is down - so it must run even when the
socket survived the background, which is why the `isWsConnected` guard moved out of the caller.
`ctx.timers.health` is cleared in two places and **started nowhere**: it is dead state, not a timer.

### WP-RECONNECT-1 - the ladder that stopped, and the two silences under it

**Fixed 2026-08-14. The above left a `reconnectCircuitOpen` latch in place, and it was the same
defect wearing a different hat.** After `MAX_RECONNECT_ATTEMPTS` (20) the ladder set the latch and
`scheduleReconnectImpl` refused every later call. Its own message named the release conditions -
retries pause *"until the app returns to the foreground or the network changes"* - and **a desktop
tab already in the foreground on an unchanged network emits neither event, ever.** So the release
condition was one an entire class of client cannot satisfy: termination from a clock, with a
resumption that is not universally reachable.

Captured on two production tabs, seven hours after a server outage, with `circuit.mjs`:

```
W1: {"online":true,"visibility":"visible","pill":"Hors-ligne","pageAgeMs":25772981}
W2: {"online":true,"visibility":"visible","pill":"Hors-ligne","pageAgeMs":25801936}

W1: CIRCUIT OPEN   watchdogTicks=2  retriesScheduled=0  socketsCreated=0
W2: CIRCUIT OPEN   watchdogTicks=2  retriesScheduled=0  socketsCreated=0
   [WS] Watchdog: socket inactive, reconnecting...     (x2, 60s apart, on each)
```

The watchdog was still firing and its request was discarded in silence - **the pair of lines is what
makes this a measurement rather than an inference**, since a watchdog tick with no
`Connection lost. Retrying in Ns...` after it can only be the early return at
`sessionConnection.ts:62`. Then the decisive experiment: a synthetic `visibilitychange` dispatched
into W1, *which was already visible*, reconnected it in under 20 s (`Reconnecting... -> [WS]
Connected`, pill `Connecté`, one socket) while W2 - untouched as a control - stayed dead. Nothing
about the network, the token or the server was wrong. Only the flag.

**The fix deletes the latch outright.** `reconnectCircuitOpen`, its two accessors and
`MAX_RECONNECT_ATTEMPTS` are gone; `reconnectAttempts` survives only as the index into
`RECONNECT_DELAYS`. Termination now comes from the two proofs that already existed:

| Terminator | Why it is a proof |
|---|---|
| `!ctx.isLoggedIn()` | There is no session to carry. |
| `SessionExpiredError` (401/403 on the refresh cookie) | The server was reached **and refused us** - an answer. Logs out, redirects to `/login`. |

A repeated transport failure is not an answer and may never end the loop. The cost that makes this
safe rather than merely correct: the backoff caps at 30 s, so a stuck tab settles at **two connect
attempts per minute** - the same order as the connection watchdog already ticking beside it, and far
below what the tab costs while connected. The two lifecycle events still land on
`resumeConnectionImpl`, but they now buy **latency, not recovery**: they reset the ladder to its 1 s
rung, so a client emitting neither still recovers on its own.

**Two further faults surfaced while fixing it, both silences:**

- `attemptReconnectImpl` called `scheduleReconnectImpl` from inside its `try`, where
  `isReconnecting` is still `true` - which is one of the two conditions on which
  `scheduleReconnectImpl` returns doing nothing. **Both failure paths were no-ops**, after logging
  `Retrying in Ns...`. The ladder never climbed itself; the 60 s watchdog was the real retry driver,
  which is why 20 attempts took twenty minutes rather than eight. The reschedule moved into the
  `finally`, after the flag is down.
- The same function nulled `ctx.timers.reconnect` without clearing it. When
  `resumeConnectionImpl` called it directly, the armed rung stayed armed, fired later, orphaned the
  rung scheduled in the meantime, and the two ladders climbed in parallel. Bounded before by the
  20-attempt latch; unbounded without it. It is now `clearTimeout`-ed.

`sessionConnection.test.ts` pins the mirror invariants: 40 rounds of the real fake clock with **no**
lifecycle event and no watchdog, asserting the ladder climbs past 20 by itself and that **exactly
one rung is armed at any moment** - unbounded in count must still be bounded in rate. Its fixture
was also completed (`getUserId`, `getDeviceKey`): without them `attemptReconnect` threw a
`TypeError`, the catch classified it as a transport failure, and every case measured a ladder driven
by the fixture's own incompleteness rather than by the connection outcome it was mocking.

**PROVEN ON A REAL CLIENT, 2026-08-15 (`ladder.mjs`, W2 against prod).** The fix is prospective, so
the original capture could not verify it - it measured a circuit that no longer exists, and a tab
reloaded to GET the fix has not lived through an outage. The proof therefore had to be MADE, and it
turns on one number: the old latch opened at 20, so **`attempt 21` is impossible under the old code
and inevitable under the new**. Held a real outage for 486 s (`armCut` + `cutHard` - offline first,
then the socket closed, since `emulateNetworkConditions` leaves an established WebSocket alone):

```
highest attempt    : 21          (old circuit opened at 20)
distinct delays    : 1, 2, 4, 8, 16, 30 s      attempts monotonic: true
watchdog lines     : 0
reconnected after  : 98 ms       (emulation lifted; NO synthetic online/visibilitychange)
```

**The zero is the second finding, and it was not predicted.** `startConnectionWatchdogImpl` returns
*before logging* when `ctx.timers.reconnect !== null`, so a silent watchdog means it found a rung
already armed on every one of its eight ticks. That is the outside view of the mirror invariant
`sessionConnection.test.ts` pins - exactly one rung armed at any moment - and it is direct evidence
that the ladder now climbs ITSELF: before the fix the watchdog was the only retry driver and left one
line per minute. The arithmetic agrees independently: 21 attempts on the `1,2,4,8,16,30…` ladder
predicts 511 s and 486 s were held, where a watchdog-driven client would have reached about 8.

Finally, `restore` only lifted the emulation - nothing dispatched the events the old circuit needed -
so the 98 ms recovery is the client's own.

### What happens on reconnect

`promoteOfflineSession.ts`, single-flight, subscribed to `connectivity.onReconnect`:

1. `getToken()`. Success sets the token and clears `isOfflineSession`. A `SessionExpiredError` means
   the session died while the device was away (expired, or revoked) - log out, keeping the local
   encrypted store, so signing back in restores the history. Any other failure leaves the session
   offline for the next attempt.
2. `startPushService` - re-registers rather than retries: FCM/APNs may have rotated the token.
3. `initializeConnection` - the same call login makes, so KeyPackages are published,
   `fetchPendingMessages` drains what the server queued, and groups reconcile under their own
   anti-purge guard.
4. **Then** `flushOutbox()`. The outbox has its own `online` listener that would otherwise fire
   before step 1, with an empty token: every queued entry would take a failed attempt and a longer
   backoff for a send that never had a chance. `canFlush: () => !ctx.isOfflineSession()` holds the
   queue until this point.
5. `historyRequestPendingStore.onResume()` and the watchdogs login skipped.

**Device revocation is not deferred by any of this.** `resetRequired` only ever arrives through
`pin-check`, which a biometric or vault login does not call *even when online* - so that gap
predates offline unlock, which merely widens the window before the next server contact notices it.
Revocation is still enforced on reconnect by the refresh answering 401 and by the gateway handshake.

#### And what is NOT a reconnect: the page leaving

A socket the browser tears down because the document is going away closes exactly like one the
network dropped - **code 1006, no reason** - so `WebMlsService.onclose` did the same thing for both:
`console.warn('[WS] Disconnected...')` and `disconnectCallback()`, which schedules a retry for a
page that no longer exists.

It is visible on the user's Firefox export of 2026-09-15, where `[WS] Disconnected. Code: 1006` and
`Connection lost. Retrying in 1s...` are the **first two lines of the new page's console** - and are
attributable at all only because the source column names the PREVIOUS page's bundle, retained across
the navigation. **Both lines belong to the document that is LEAVING**: `performance.now()` in their
prefix is measured against the OLD navigation, so an export spanning a reload carries two epochs and
the opening pair sits at the end of the first one, not at the start of the second.

The discriminator is carried from where it is known rather than guessed at the close:

| event | what it sets | why |
| --- | --- | --- |
| `beforeunload` | `pageIsHiding = true` | the decision to leave, and the EARLIEST thing the browser says about it - the teardown follows it, so the flag is already true when the close arrives |
| `pagehide` | `pageIsHiding = true` | the same flag, for the paths `beforeunload` does not reach (a bfcache entry, a tab discarded without an unload) |
| `pageshow` | `pageIsHiding = false`, then reconnect if the socket is not open | a bfcache restore brings the same document back with a socket that really is gone, and nothing else would notice |

**`pagehide` ALONE WAS NOT ENOUGH, and the 2026-09-16 export is the proof**: the same two lines came
back on a build carrying the guard, which can only mean the close reached `onclose` while the flag
was still false.

The ordering was read off a local rig rather than assumed - one page, one WebSocket, every event
appended to `sessionStorage` so the departing life can be read from the next one. Two consecutive
Chrome reloads, 2026-09-16:

```
ws open                             15.5      17.0
beforeunload                      7718.2   13350.9
pagehide                          7723.3   13356.3
visibilitychange -> hidden        7723.3   13356.4
```

**`beforeunload` leads `pagehide` by ~5 ms, and no `close` is delivered at all** - which is why
Chrome never showed this symptom, and why a guard hung on `pagehide` looked correct here. Firefox
delivers a close in that window; that half is reasoned, since Firefox cannot be driven from the
session that wrote this.

Registering `beforeunload` costs no bfcache eligibility - `unload` is the listener that disqualifies
a page, and this codebase has none.

A real navigation takes the whole client with it, so there is nothing to clean up on that path.
Pinned by `WebMlsService.pageLifecycle.test.ts`, whose four cases are the states the page can be in
when a close arrives - **including a close that BEATS `pagehide`, which is the case the first version
of that test did not have, and why the symptom survived it.**

### Login failure codes

`session/loginErrors.ts` defines `LoginFailure` with a machine-readable `LoginErrorCode`
(`pin_mismatch`, `local_state_unopenable`, `keystore_empty`, `device_revoked`, `other`), passed
to `onLoginFailed(message, code)`. **Branch on the code, never on the message**: the message is
localized, so a regex over it silently stops matching in another locale - that is exactly how the
cross-device recovery link once became unreachable in French.

### Two iPhone 12 findings of 2026-10-07: a name saved for the previous account, and a reset button under the footer

**The composer avatar read "Avatar de <previous user>" after a switch.** `saveUserLocally` only wrote
`canari_user_display_name` when the caller carried a `displayName`, and the token refresh and the
session restore carry none. After gamma then delta the key still held gamma's name, and
`getUserDisplayNameSync` caches the saved name AGAINST THE CURRENT ID, so delta's avatar was labelled
gamma. The key is now dropped when the stored id differs from the incoming one, beside the other
account-scoped verdicts (`user.saveUserLocally.test.ts`). The avatar and `PostIdentityPicker` were
never at fault: the id they passed was right, the saved name was not.

**"Reinitialiser mon PIN" sat under the unlock footer.** The forgot box opens below the fold of the
form's scroll region, and the footer lives OUTSIDE that region (it must not scroll), so on 390x844
the button was only reachable by a drag started on the keypad, and a tap at its position hit
"Deverrouiller". Opening the box now scrolls it to the end of the region (`scrollIntoView`).
Measured in headless Chrome at 390x844 with `--safe-area-inset-top/bottom` 47/34 px: the button ends
at y=645, the footer starts at 706, and `elementFromPoint` on its centre is the button. No real
iPhone read of the fix: only WebKit's own scrolling settles that.
