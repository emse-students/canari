# From a notification tap to a sent reply, measured

**THE USER'S GOAL (2026-10-11): a message notification is tapped, the conversation is on screen, a
reply is sent - and that whole path must be extremely fluid, app killed OR backgrounded, on Android
and iOS.** This page is the MEASUREMENT behind that goal and the ranked plan it argues for. Phase 1
was study only: nothing here changed production code. What is owed is in
[backlog](../backlog.md#p2---a-notification-tap-takes-27-s-to-a-usable-conversation-when-killed-5-s-behind-the-pin-measured-2026-10-11);
the cold start in general is [cold-start](cold-start.md), whose instruments this page reuses.

**NOTHING ON THIS PAGE IS A PRODUCTION NUMBER.** The phone ran `1.2.3-alpha.5` against
`dev.canari-emse.fr`, on an account holding ONE conversation of a few dozen messages. Every network
step is the dev estate's round trip (150-700 ms here), and every MLS and history step is the cost of
a tiny state - production states are megabytes ([cold-start](cold-start.md)). **What transfers is
WHICH steps sit on the path and in what ORDER**, not their absolute size.

## The instrument (temporary, not committed)

One run = one tap, read on ONE clock - the phone's:

- **The tap** is the exact `PendingIntent` `CanariFirebaseMessagingService` builds for a message
  notification: `MainActivity`, `ACTION_VIEW`, `fr.emse.canari://chat/<groupId>`,
  `NEW_TASK | CLEAR_TOP | SINGLE_TOP` (`0x34000000`), fired with `am start`. **T0 is the
  `ActivityTaskManager: START u0` line** (`logcat -v epoch`). A human tap through the shade adds the
  shade's collapse, which no run here includes; and a real push often leaves the process ALIVE
  (the FCM service decrypted the message), so "cold" below is the worst case: process dead.
- **Process and window**: `Start proc` and `Displayed` from logcat.
- **The page**: `performance.timeOrigin` (an epoch, same clock as logcat), the boot bench
  (`window.__canariBootBench.get()`: `app-first-line`, `login-start`, the PIN and MLS spans,
  `MLS ready`), and the app's console over CDP (`Runtime.consoleAPICalled`, each line stamped by
  the device).
- **The screen**, from an in-page recorder installed over CDP (a 16 ms poll writing the first
  `performance.now()` at which each predicate held): PIN gate up, route `/chat`, the target's pane
  open (`.chat-messages-scroll` naming the conversation), a first history row (`[id^="msg-"]`),
  the composer (`.chat-composer-footer .chat-composer-editor`) laid out with no gate over it.
- **The reply**: a marker typed with `Input.insertText`, the send button clicked; the bubble
  appearing, and **`[OUTBOX] <id> sent in <group>`, the outbox's own line once the server took
  it**, as "reply accepted". The bubble's grey tick is NOT used: it sometimes showed hundreds of ms
  BEFORE that line (warm runs: tick ~1.0 s, outbox line ~1.5 s). `MessageMetadata` draws the sent
  tick for any status that is not `pending`/`sending`/`error`; whether a transient `undefined` is what
  drew it early is not established - noted, not filed.

The PIN, when asked, was entered by the instrument in ~130 ms. **A human takes 1.5-3 s that no
number below includes.**

## The numbers (Mi 9T, 2026-10-11, medians with [min-max], ms after the tap)

| milestone | cold, PIN (n=6) | cold, "Rester connecte" (n=5) | warm, backgrounded (n=6) |
| --- | ---: | ---: | ---: |
| process started | 26 [17-38] | 13 [11-24] | (alive) |
| window displayed (`Displayed`) | ~295 | ~280 | (resumed at 9-38) |
| WebView navigation start | 563 [538-580] | 544 [510-574] | - |
| first line of app code (`app-first-line`) | 1022 [1002-1075] | 987 [954-1048] | - |
| deep link parsed (`[notifNav] deep link received`) | ~1230 | ~1280 | 55-131 |
| PIN gate on screen | 2113 [2075-2139] | - | - |
| PIN submitted (instrument, ~130 ms) | 2245 | - | - |
| `login-start` | 2250 | 1623 [1554-1680] | - |
| `MLS ready` | 4022 [3987-4383] | 2168 [2063-2487] | - |
| `[notifNav] routing to /chat` | ~4030-4420 | ~2100-2520 | 75-144 |
| route is `/chat` | 4655 [4620-4779] | 2396 [2299-2711] | <= 354 |
| **pane + composer usable** | **4979 [4939-5073]** | **2695 [2592-3155]** | **<= 354 [322-446]** |
| first history row | 5425 [5370-5502] | 3463 [3128-3760] | <= 354 |
| reply bubble (after the click) | +127 | +89 | +68 |
| **reply accepted (`[OUTBOX] ... sent`), after the click** | **+1071 [190-1501]** | **+752 [415-906]** | **+~950 [740-1360]** |

The warm column's screen predicates all fired on the recorder's first tick after the activity
resumed, so `<= 354` is an UPPER bound: the app had routed at 75-144 ms and the poll was throttled
while hidden. Five warm runs spent 4 s in the background, one spent 60 s; it did not differ.

**Read end to end, tap to "I can type": ~0.35 s warm, ~2.7 s cold with "Rester connecte", ~5.0 s
cold behind the PIN plus the human typing it** - so ~6.5-8 s for a PIN user, and a reply is taken
by the server ~0.75-1.1 s after the send button on top of that.

## Where the time goes, ranked

Ranked by what a cold PIN user pays, which is the default (the checkbox is unticked by default).

| # | block | cold PIN | cold vault | warm | what it is |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | **the PIN path** | ~1.8 s app + 1.5-3 s human | 0 | 0 | gate -> `MLS ready`: salt fetch 150-210 ms, verifier PBKDF2 60-120, PIN check 150-190 (two round trips), device-key PBKDF2 **680-750**, `mls-init` **440-450** |
| 2 | **tap -> first line of app code** | ~1.0 s | ~1.0 s | 0 | process + activity ~290, WebView to navigation ~250, bundle parse + evaluation ~450 (`domContentLoaded` 439 ms after navigation) |
| 3 | **target known, not shown** | ~2.8 s | ~0.9 s | 0 | the deep link is parsed at ~1.25 s; the landing routes only after `MLS ready` (`landingStep`) |
| 4 | **first line -> gate / login** | ~1.1 s | ~0.63 s | 0 | the token refresh (555-706 ms on dev) precedes both; the PIN gate appears ~1.07 s after the first line |
| 5 | **routing -> usable composer** | ~0.95 s | ~0.5 s | <= 0.35 | `/chat` route 230-650 ms after `MLS ready`, then the pane ~300 ms |
| 6 | **pane -> first history row** | ~0.45 s | ~0.55-0.77 s | 0 | coincides with `[CATCHUP] batch history` (+-200 ms); local read vs network NOT separated |
| 7 | **reply acceptance** | ~1.07 s | ~0.75 s | ~0.95 s | outbox durable write ~230 ms, then flush, MLS encrypt, POST; a `KeyPackage published` interleaves; warm waits for the socket (below) |

### What the spans say that the medians hide

- **The PIN path is slow because the main thread is busy, not because of the cryptography.** The
  device-key PBKDF2 (310 000 iterations, WebCrypto) costs 117-195 ms when nothing else runs - the
  an earlier boot of the same install, PIN typed by hand, read 117 ms, and the one instrument run whose PIN
  check took 1.3 s read 195 - and **680-750 ms** in the five others. `mls-init` is ~70 ms on the
  vault path and **~450 ms** after a PIN (`mls-load-state` 170 vs 8-27, `mls-list-groups` 270 vs
  40-70). A WebCrypto promise resolves only when the main thread takes it, so these spans include
  whatever was running. **What ran**: the cold start lands on the default route, so the FEED boots
  underneath the landing - `GET /api/posts`, `/audience`, `/my-scheduled`, `/announcement`, then
  `[progressive-mount] all 20 mounted` at ~4.25-4.5 s, exactly while the PIN path and the routing
  run. This is a CORRELATION, not a proof: the heartbeat of `tools/cold-start/` is the instrument
  that would name the block, and it was not run.
- **The `/chat` route takes 650 ms after a PIN and 230 ms without one** - the same feed mount sits
  in that window on the PIN path and not on the vault path, where the feed's requests went out
  earlier.
- **The landing waits for MLS, by design.** `landingStep` routes once the session is up; on the
  vault path that is ~0.9 s after the target is known, on the PIN path ~2.8 s. Nothing in that wait
  is needed to DRAW the conversation's shell, and on the vault path the local history is readable
  as soon as the device key is restored (~1.66 s).
- **The token refresh is the first network step and both gates sit behind it**: `refresh->` at
  ~1.08 s, its success line 555-706 ms later. `[PIN] No device key in vault` is known at ~1.6 s, but the
  gate is drawn at ~2.1 s.
- **Warm, the socket is the reply's whole cost.** After a background the socket is paused; on the
  tap `onResume` fires at 9-38 ms and the service's own reconnect request is refused ("paused until
  the app is foreground") at 14-57 ms, correctly. `[LIFECYCLE] App in foreground` reads 482-589 ms,
  and the first reading of it - "a foreground flag arriving late" - was WRONG: that line is printed
  AFTER the resume's preparation, which STARTS ~50 ms after the tap and waits 0.5-0.7 s, mostly on
  the landing's `/chat` render holding the main thread (~250 ms). The socket connects at
  734-1258 ms and the outbox flushes after it. **The lever is the warm `/chat` render, F1's ground**
  (F5, measured on a later build).
- **The reply's own path is fine to the eye**: the bubble is on screen 54-337 ms after the click.
  What takes ~0.75-1.1 s is the acceptance, and the user does not wait on it unless it fails.

### F2 - the feed no longer draws under a landing (cause confirmed, then measured)

**The heartbeat named the block before anything was built.** A 50 ms main-thread probe plus the
`long-animation-frame` observer, installed by the tap instrument, on three cold PIN runs: ONE block
of 681-703 ms starting ~0.65 s into the device-key PBKDF2, attributed to the continuation of
`listPosts`' `await res.json()` - the feed drawn from its first answer - then 8-10 frames of
100-200 ms from the posts route's `requestAnimationFrame` (the progressive mount) across `mls-init`
and the routing. The correlation was the cause.

**The fix** (`feedHeldForLanding`, `routes/posts/+page.svelte`): while a landing is ON ITS WAY
(`notifNav.enRoute`: a target is pending and its route has not been reached), the feed's FIRST draw
is held (skeletons, nothing to mount). The landing effect calls `notifNav.markArrived()` the moment
`landingStep` answers `select`, and an abandoned landing clears the target, so either ends the hold.
**`pending` alone is the wrong release** - the first version used it, and review caught it: the
target stays pending while displayed and, on a wide screen, after the reader leaves `/chat`, so a
feed reached afterwards would have shown skeletons for ever. A feed already on screen is never
blanked. The requests still go out - they cost the network, not the main thread. The measurement
below was taken on the first version; the two hold identically until the route is reached, which on
a phone is when the feed is unmounted, and the phone was handed to another session before a rebuild.

| cold, PIN (n=6, medians, ms after the tap) | baseline (`main`) | F2 |
| --- | ---: | ---: |
| device-key PBKDF2 | 658 [115-713] | **125** [113-130] |
| `mls-init` | 429 [155-582] | **46** [38-156] |
| `MLS ready` | 4053 [3348-4446] | **3230** [2959-3557] |
| route is `/chat` | 4696 [3595-4997] | **3446** [3204-3806] |
| **pane + composer usable** | **5063** [3864-5307] | **3825** [3539-4077] |
| first history row | 5605 [4502-5903] | 4565 [4201-4991] |

**~1.24 s off the composer for a PIN user**, the high end of what the plan expected. Both builds
are release APKs of the same tree but for the change (`android.yml` dispatched with
`publish: false`), installed with `install -r` over the bench device. One baseline run had already
shown it by accident: its feed answer came late, nothing was drawn under the landing, and it
read PBKDF2 115 ms and the composer at 3.86 s. Back from the conversation, the feed draws its 20
cards as before.

### Noise seen on the way (not on the critical path, written down so it is not rediscovered)

- `[hooks] launch URL already acted on by this start, ignoring the replay` appears 2-4 times per
  cold start - the four `getCurrent()` re-reads, deduplicated as designed ([mobile](mobile.md)).
- `Warning: Cannot load system font: TimesNewRomanPS-BoldMT` twice after opening the conversation -
  a PDF in its history, rendered by the PDF viewer.
- The native HTTP client opens a NEW connection to the estate for each minute-spaced request
  (`reqwest::connect starting new connection` every 60 s while idle).

### F3 - the PIN gate is drawn on the local fact (measured)

**What held the gate was not the refresh itself but a question that needed it.** `openPinModal`
awaited `detectFirstPinSetup` - `GET pin-status`, which takes an access token - before drawing the
keypad, so the gate waited for the refresh (555-706 ms on dev) AND a round trip, although "no
device key in the vault" was known at ~1.6 s. The answer only chooses the wording ("choose" vs
"enter" your PIN): registration is the server's decision at `pin-check`.

**The fix** (`firstPinSetupFromDevice`): a device holding an enrolled device id for this user
(`mls_device_id_<userId>`, written by `resolveDeviceId`, never cleared by a sign-out) is a returning
one, and the gate is drawn at once; only a device that never enrolled the user still asks the
server. The one reading that changes: a first setup interrupted between the device id and
`pin-check` now reads "enter your PIN" on its next launch, and its PIN is still registered as given.
A device with a local state is never told "first setup", which is what
`pinFirstSetupRefuted.test.ts` already demands.

| cold, PIN (n=6, medians, ms after the tap) | baseline (`main`) | F3 |
| --- | ---: | ---: |
| `[PIN] No device key in vault` | 1701 [1615-1815] | 1662 [1636-1718] |
| **PIN gate on screen** | **2187** [2085-2275] | **1741** [1711-1796] |
| PIN submitted by the instrument (`login-start`) | 2325 [2195-2405] | 2060 [2002-2079] |

**~0.45 s sooner on screen**: the gate now follows the vault answer by ~70 ms. A human typing a
PIN takes longer than the refresh, so the PIN check still finds its token ready. The composer column
is not quoted for this build: it still carries the feed contention F2 removes, which scatters it by
±0.9 s run to run.

### F1 - the conversation is drawn from the local store before the session is up

**Decided by the user on 2026-10-12**: open the conversation as soon as the notification link is
parsed, and fill it from the LOCAL store while the token and the revocation question are still in
flight. A revoked device removes everything drawn and signs out exactly as before. **F4 was NOT
approved, and the PIN flow is unchanged.**

**What may happen before the session, and what may not.** The landing effect
(`ChatBackgroundService.svelte`) routes to `/chat` as soon as `notifNav.pending` is set, and no longer
waits for `isLoggedIn`. `loginImpl` starts `readLandingPreview` (`utils/chat/landingPreview.ts`)
as soon as the device key is known. That function only reads: `getConversation` plus the newest
`INITIAL_MESSAGES_PAGE`, decrypted with the device key. It makes no request, writes nothing, touches
no MLS state and skips the hex-id resolution, which goes to the network. A community salon has
nothing to draw because its history is never stored. Before the session, `previewSelect` sets the
selection and pushes the Back entry, and does nothing else: no read mark, no member load, no history
fetch. While the preview shows, the conversation list is not mounted, the thread and its chrome are
`inert`, and no typing frame is sent. `notifNav` and `notificationRouting` are not modified. The
`route -> await-arrival -> select` order and the Back and landing rules hold as before. Once the
session is up, the landing runs `openNotificationTarget` once, as on `main`.

**The PIN path draws nothing before the PIN is accepted, by data dependency.** The device key behind
a PIN is handed back by `unlockWithPin` only after `pin-check` has answered `ok` or `registered`, and
that same answer carries `resetRequired` (the revocation); since F9 the derivation overlaps the
check, but its result is still released only after it (`pinUnlock.test.ts`). With no key, nothing
can be decrypted, so the preview starts after `unlockWithPin` returns (`landingPreviewOrder.test.ts`
pins that order). The gate is not dismissible and pushes no history
entry. Before the unlock, the route may already be `/chat` under the gate, but nothing is decrypted
or drawn until the PIN is accepted. On the vault path ("Rester connecte") the key is local, so the
preview starts before `await getToken()`. On the biometric path it starts once the keystore has
released the key.

**A reply typed during the preview is held, and the save-before-send rule is kept.** `MainChatPage`
holds a send (text, files, voice note) until `isLoggedIn` turns true, then sends it through the
normal path. That path is `saveMessageWithOutboxEntry`: the echo and the outbox entry are written
in one transaction before anything leaves. `registerOutbox` runs in the same synchronous run that
sets `isLoggedIn`, so the released send always finds the outbox controller (a source guard pins
that). Each held send remembers the conversation selected when it was pressed, and is released
only if that conversation is still the selection (`heldSends.ts`). While anything is held, a
"sending as soon as the session is ready" line shows above the composer, so nobody types it again.
A held send that does not go is never silent: if the login ends without a session, if the selection
moved, or if the page is left, an error toast says how many were not sent and the log names them.
The toast outlives the page and the redirect to `/login`. The text is not put back, because the
conversation it was written in is no longer on screen.

**Withdrawal.** `withdrawLandingPreview` is synchronous and never waits on the store. It deletes the
drawn row and its reactions, abandons its Back entry and clears the selection, and a read still in
flight finds the login withdrawn and draws nothing. Each login is numbered, and a discard removes
only the preview its own login drew, so a failing login cannot remove the preview of a later login
that overlaps it. On a session that expired and on an identity split, the redirect (or the notice)
comes first, the withdrawal second, and the login flag is released last. It also runs in the login's
`catch`. On the revoked branch it runs first, then the read is allowed to finish (the store is
already open there, so this cannot hang), and only then does `wipeRevokedDevice` start. Leaving the
landing before the session is up discards the preview, and so does a SECOND notification tapped
before it is up: the landing then names another conversation, and the first preview would otherwise
stay selected under it, open to a reply the reader meant for the other thread (found in review,
2026-10-13; the effect compares the pending target with the previewed key, not with `null`). So
does leaving the chat page while the
preview is selected: the page reports the held sends, discards the preview and clears the landing. The restore that follows a
successful login keeps that one row's page through its prune of the non-salon rows (`preserveMessagesOf`), so the
thread does not go blank while Phase 2 waits on the network.

**Measured (Mi 9T, dev, `BenchR1`, ms after the tap, median [range]; baseline `571c633e0`).**

| vault, normal network | baseline (n=6) | F1 (n=7) |
| --- | ---: | ---: |
| routed to `/chat` | 2366 [2141-2470] | ~1840 [1770-1910] |
| pane and composer | 2630 [2425-2745] | 2792 [2659-2892] |
| history rows drawn | 3393 [3261-3594] | 2792 [2659-2892] (with the pane) |

| PIN (ms after `login-start`; the instrument's PIN submit time is erratic) | baseline (n=6) | F1 (n=7) |
| --- | ---: | ---: |
| pane and composer | 1274 [1220-1343] | 1334 [1208-1371] |
| history rows drawn | 1964 [1880-2084] | 1334 [1208-1371] (with the pane) |

On a slow network (refresh ~3.1 s, revocation ~3 s; only n=2, so an indication rather than a
median), F1 drew the pane at 2463 and 2410 ms, while
`MLS ready` came at 7280 and 4623 ms. On `main` the pane cannot appear before `MLS ready`. A reply
typed in that window was held and sent when the session came up, as seen on the phone.

**Honest reading.** On a good network, history arrives ~0.6 s sooner and routing ~0.5 s sooner. The
composer is unchanged or slightly slower: on the vault path its median moved from 2630 to 2792 ms
(+160 ms), and on the PIN path by +60 ms. The gain on a slow network looks large, but it rests on two
runs. The gain predicted in the
plan below (usable at 1.4-1.6 s) did not happen. On Tauri the preview's store open costs ~380 ms
(`[DB] Using SQLite storage` comes ~380 ms after `login-start`), and the read and decryption of 60
rows follow it. So the preview usually lands just after `MLS ready`, and its render collides with
the token continuation (a ~450 ms long animation frame). Warming the store earlier was rejected: it
could reopen the database during a revocation wipe, the hazard named in
[durable-rules](../durable-rules.md) (the teardown that starts its own competitor). The preview
reuses the session's own `getStorage` connection, so no second reader is left open for a wipe. The `[LANDING_PREVIEW]` line now prints the store-open and
read durations separately, so the next lever (a smaller first page, or a cheaper open) can be chosen
on numbers.

### F9 - the PIN salt is asked while the keypad is up, and the device key is derived during the check (measured: submit to `MLS ready` -0.3 s)

**The spans of a cold PIN open after F2 and F3** (Mi 9T, `1.2.4`, 2026-10-12, one run shown, the
other five within ~30 ms): `pin-salt-fetch` **350 ms**, `pin-verifier-pbkdf2` 117, `resolve-device-id`
44, `pin-check-request` 253, `device-key-pbkdf2` **166** - ~0.93 s from the submit to `mls-init`,
all of it in series. Two of those steps wait on nothing they need:

- **The salt does not depend on the PIN.** It was asked at submit, after the person had typed, and on
  a fresh process it is also the request that opens the connection. `openPinModal` now starts it
  (`pinSaltAhead.ts`, `prefetchPinSaltImpl`) and `loginImpl` consumes it. An entry is used ONCE (a
  retry after a failed unlock gets its own round trip, asked again from `applyPinFailure` - the
  keypad's own wrong-PIN handler, the saved-PIN path and the biometric button all pass through it -
  and NOT after a `device_revoked` wipe, which leaves no session to ask with). The salt lives in
  memory only, as it already did for the length of every login. **A first setup is excluded**:
  `GET pin-salt` WRITES a placeholder row for a user with no salt, which `pin-status` then reads as
  "registered", so asking it ahead could turn an abandoned keypad into a skipped PIN choice.
- **What the review found, and how each is closed** (2026-10-12):
  - *A failure is a value, not a rejection.* An entry settles to `{ failure }`, so a submit that took
    it before it failed is never handed the prefetch's exception: `unlockWithPin` logs the failure
    and asks the salt at submit with that login's own token - the round trip every submit made
    before - whose failure is its own (`auth_pin_salt_unreachable`).
  - *Forgotten when the keypad ends* (`forgetPinSaltAhead`): any unlock (PIN, biometrics, vault), the
    keypad closing, `clearAuth` (sign-out, session expiry, revocation wipe) and a PIN reset.
  - *A salt made stale by a PIN reset is never a wrong PIN.* A reset deletes the row and the next GET
    mints another salt, so a keypad's salt can be stale. `pin-check` is now sent the salt the verifier
    came from and answers **`stale-salt`** without comparing, storing or resetting anything - which
    also closes the case where, with no row left, the old code REGISTERED a verifier under a salt the
    server never stored. The client asks the salt again and checks once more; a second `stale-salt`
    is refused by name (`pin_salt_rotated`). A client that sends no salt is answered as before.
  - *The key is installed on an ALLOWLIST of answers*: only `ok` and `registered`. It used to be
    installed for anything that was not `mismatch` or `stale-salt`, so a `200 {}` unlocked; any other
    answer is now logged and refused (`other`, `auth_pin_check_unexpected`) with the key unread.
  - *Behavioural tests, not regexes*: the PIN half moved to `pinUnlock.ts` (`unlockWithPin`, every
    dependency passed in), and `pinUnlock.test.ts` answers `mismatch`, `resetRequired` and a double
    `stale-salt` and watches `installDeviceKey` stay uncalled.
- **The device key does not depend on the PIN check.** It was derived AFTER `pin-check`, "on purpose".
  The purpose is a rule about USING the key - nothing is decrypted with a key from an unproven PIN -
  and that rule is kept: the derivation now starts once the verifier is computed, runs during the
  check's round trip, and its result is awaited and installed (`ctx.setDeviceKey`) only after the
  check answered and after the `mismatch` and `resetRequired` branches. On a mismatch it is dropped
  unread (`pinUnlock.test.ts` asserts it by behaviour). `resolveDeviceId` (a stored id, nothing
  decrypted) joins the verifier.
- **After the verifier, not beside it - and that was measured, not assumed.** The first version
  started both derivations together: they share the WebCrypto worker, the verifier went from ~112 to
  **215 ms** and delayed the check it feeds by as much, so it gained ~0.1 s less.

| killed, PIN typed by the instrument ~130 ms after the gate (n=6 each) | without (4 builds, n=24) | beside the verifier | **during the check** |
| --- | ---: | ---: | ---: |
| `pin-salt-fetch` at submit | 212-239 | 76 | **27** |
| `pin-verifier-pbkdf2` | 53-112 | 215 | 112 |
| submit -> `MLS ready` | 742-886 (median per build) | 584 | **489** [433-975] |
| composer usable | 3543-4117 | 3426 | **3266** |

**~0.3 s off a PIN unlock with a keypad typed in 130 ms**; a person typing for 1.5-3 s leaves the salt
fully absorbed, so the gain is at least that.

## The ranked fix plan

**Each line names its expected gain on THIS bench and the risk that decides whether it is worth
it.** Gains are not additive: 1 and 2 overlap.

| # | change | expected gain | risk |
| --- | --- | --- | --- |
| **F1** (MEASURED, see the section above: history -0.6 s, composer unchanged or slightly slower on a good network) | **Route-first landing.** Route to `/chat` and select the target the moment the deep link is parsed (~1.25 s), drawing the conversation's shell (name, avatar, composer) before `MLS ready`; fill its history from the local store as soon as the device key is restored; a reply typed meanwhile goes to the outbox, which already holds sends until the session is up. Behind the PIN, the gate covers the target's page instead of the feed. | vault: usable at **~1.4-1.6 s instead of ~2.7 s**; PIN: the conversation is ALREADY there when the PIN is accepted (saves the ~0.95 s of block 5) | **medium-high**: `landingStep`'s `route -> await-arrival -> select` and the overlay/Back rules ([chat](modules/chat.md#and-the-re-verification-it-asked-for-says-the-mechanism-is-there-and-the-landing-destroys-it-2026-09-21)) must hold; the revocation gate must still precede anything that ACTS on the session ([cold-start](cold-start.md#the-revocation-gate-stays-in-front-of-the-prompt-and-the-launchs-console-noise-is-explained-pixel-6a-2026-09-15)) - drawing local history before the revocation answer (~110 ms on the vault path) is a decision for the user |
| **F2** (MEASURED: composer 5.06 -> 3.83 s, cold PIN) | **Do not boot the feed under a notification landing.** When the launch URL targets a conversation, skip the default route's feed load and mount (requests and the 20-post progressive mount) until the user goes there. | PIN: device-key PBKDF2 ~700 -> ~150 ms, `mls-init` ~450 -> ~70, route ~650 -> ~230: **~1.0-1.4 s if the contention is the feed** (to be confirmed by the heartbeat first); vault: ~0.1-0.3 s and four requests | **low**; confirm the cause with `tools/cold-start/launch-trace.mjs --heartbeat` BEFORE building - the correlation above is not a proof |
| **F3** (MEASURED: gate 2.19 -> 1.74 s) | **Draw the PIN gate on the local fact, not after the refresh.** "No device key in the vault" is a local answer; let the user type while the refresh runs, and verify when both are in. | ~**0.5-1.0 s** of the PIN user's wait (the gate up at ~1.1-1.6 s instead of ~2.1 s) | **medium**: a refused refresh must still end on the login screen, and the PIN check needs the token - the typing overlaps the refresh, it does not replace it |
| **F4** | **Make the no-PIN path the expected one**: "Rester connecte" / the biometric 12 h cadence ([auth](modules/auth.md#how-often-the-sheet-comes-back---the-biometric-cadence-2026-09-28)). | **~2.3 s of app time plus the 1.5-3 s of typing** (cold PIN 5.0 s vs vault 2.7 s to the composer) | a **security and product decision for the user**, not an optimisation |
| **F5** (REFUTED: the verdict is not late; see the warm bullet above) | **Warm: reconnect on the native resume, not on the late JS foreground verdict.** | **~0.5 s** off a warm reply's acceptance (socket at ~0.3 s instead of ~0.8 s) | **low-medium**: the pause/resume symmetry and the breaker rules ([auth](modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)) |
| **F6** | **Pane -> history**: instrument the selection (local page read vs catch-up), then draw the cached page in the same frame as the pane. | **~0.3-0.6 s**, if the rows wait on the network | **low**; measure first - the rows sometimes PRECEDE the catch-up line |
| **F7** | **Prewarm on push receipt**: when the FCM service is woken for a message, initialise the WebView provider so a tap does not pay it. | ~**0.2-0.3 s** of block 2 | **medium**: memory and battery on every push, and Android may reclaim it anyway |
| **F8** | **Reply acceptance**: start the flush while the durable outbox write completes, and keep the post-send KeyPackage publish off the send's lane. | ~**0.2-0.4 s** | **high**: durable-before-send is a rule of the outbox ([offline-and-weak-network](offline-and-weak-network.md)); lowest priority |

**Not in the plan, deliberately**: the bundle's parse time (block 2's ~450 ms) - [cold-start](cold-start.md)
already refuted chunking as the lever twice, and the JavaScript itself is the cost; and the MLS load,
which is ~10-30 ms here and must be re-read on a production-sized state before anyone touches it.

### F5 - the warm diagnosis was wrong, and the fix it suggested measured to nothing

**The JS foreground verdict is NOT late.** The `[LIFECYCLE] App in foreground` line now carries
what the resume made the socket wait for, step by step (`(resume prepared in N ms: reload, outbox,
call, fcm, watermarks)` - one line per resume, as before). On six warm taps the sequence STARTED
~50 ms after the tap and took 528-717 ms (median ~564). That line is printed by `resumeConnection`
AFTER the sequence, so
"reconnect on the native resume" would have changed nothing: the resume already begins at once. The
reconnect requests refused at 14-57 ms are the service's own foreground hook, answered correctly
while the pause is still up.

**No step is slow on its own.** The native `read_and_clear_pending_call_accept` is a one-file read,
yet the step around it took 370-450 ms in five runs of six (the outbox step 384 ms in the sixth).
An await only returns when the main thread is free, and the landing's `/chat` render holds it for
~220-260 ms right then (`long-animation-frame`: one `import.then` continuation at ~100-170 ms), so
whichever step is in flight absorbs it.

**Refuted by measurement:** running the independent steps side by side (outbox, call drain,
FCM -> watermarks after the `mls.bin` reload) left the preparation at 508-608 ms (median ~570, n=8).
The block moved to the watermarks step (382-473 ms) and the socket still connected at ~0.9 s. Not
shipped. Moving the reconnect ahead of the preparation would break the order the sequence exists for
(the FCM cache and the read watermarks before the socket pulls queued rows, the outbox reconcile
before the flusher), so the lever is the `/chat` render on the warm landing, which is F1's ground.

| warm (ms after the tap, medians) | baseline (`main`, n=6) | resume steps in parallel (n=8) |
| --- | ---: | ---: |
| `[LIFECYCLE] App in foreground` | 615 | 646 |
| socket connected | 931 | ~920 |
| reply accepted, after the click | 839 | 911 |

### F12 - the notified message is asked for when the rows exist, not after the history restore

**What the killed timeline showed** (Mi 9T, 2026-10-12): the socket's first pull lands before the
restore has seeded a single row, so the notified frame is refused `absent-conversation` and left in
the server queue. It was asked for again only by `notifyConversationsRestored`, at the END of
`loadExistingConversations` phase 2 - after `getUserGroups`, the batch history, and every
conversation's stored page and archive replay. The conversation pane and its composer were up
~1.0 s before the message they were opened for.

**The fix is an earlier trigger, and what had to be proven is phase 2's side of it.** Phase 1 creates
every row the restore will ever create, synchronously, so right after it
`notifyConversationRowsSeeded` re-fetches the refused frames. A live decrypt can now land while phase
2 still runs, and four things decide whether that is safe:

- **The archive replay must not deliver the frame a second time.** It pins its head, then waits for
  the mailbox at `waitForGroupQueueIdle`, which awaits `pendingPullInFlight`. That pull used to be
  announced only AFTER `fetchPendingMessages` had awaited its ack ordering, so for one ack round trip
  a pull existed that no barrier could see. It is now announced in the tick it is asked for (the ack
  ordering moved inside it, still before the request). The live decrypt then lands first, is
  ledgered, and the replay skips it - the reverse order is the `Duplicate delivery` noise. Two
  pulls can now overlap (a reconnect and this one), so the slot is CHAINED rather than overwritten
  and cleared only by the pull that still owns it: before the review, the first pull to finish
  nulled it while the other was still fetching, and the barrier passed (found in review, covered by
  `BaseMlsService.ackBarrier.test.ts`).
- **Phase 2 must not erase what a live delivery wrote.** Its stored-page write ASSIGNED `messages`
  (now `mergeMessagePage`, the rule every other history write already follows), and the DM repair
  spread a copy of the row read before an `await` (now re-read after it).
- **A bulk flush must not either.** `batchAddMessages` yields every 50 messages and wrote back the row
  it had read before its loop; it now merges into the row as it is when it writes, without adding a
  message twice.
- **Durability is unchanged.** Live drains already ran inside phase 2's persist-only window for any
  frame arriving during it; this change makes that overlap routine, not new.

**And measuring it found a second delay, in a mechanism nothing watched.** Half the runs still drew
the message ~1 s late. Bulk-ingest windows were closed as a LIFO stack, but they overlap: a selected
conversation's history load opened one DURING the drain and outlived it, so the drain's close ended
the history load's persist-only window and the drained message waited in the UI buffer until the
history load closed (`bulk ingest depth=3` opening 60 ms after `Drain start`, the batch flush 630 ms
after `Drain complete`). `beginBulkIngest` now returns a handle and `endBulkIngest(handle)` closes
that window.

| Mi 9T, killed, local APKs against dev, n=6 each, ms after the tap | without | rows-seeded trigger only | **F12** (with handles) |
| --- | ---: | ---: | ---: |
| notified message drawn | 4557 [4449-5041] | 4362 [4029-4992] | **4090** [3927-4405] |
| composer usable -> notified message drawn | 1002 [948-1051] | 768 [500-1060], bimodal | **396** [365-609] |
| warm (bg): notified message drawn | 1750 [1555-1925] | 1609 [1557-2101] | 1789 [1504-2240] (unchanged, expected) |

**~0.47 s off the killed open, and the message now follows the composer by ~0.4 s instead of ~1.0 s**;
no run of the fix overlaps the baseline's range. The warm path never had the defect (its rows exist).
One killed run's reply ack took 2.1 s: the flush waited behind the post-login KeyPackage publication,
the F8 item, unrelated to this change.

### F13 - drawing only the newest screenful on entry: measured, no gain, not shipped

The next lead after F12 was the thread mount (~0.3 s in the profile). Tried 2026-10-12: the entry
window cut from 60 groups to 24 (one phone pane), with `fillViewportThenPin` widening one entry
window per pass instead of a 140-group page. Same tree with and without, n=6 each on the Mi 9T:
**warm tap -> composer 919 [798-1001] vs 920 [845-1278]**, and the killed pane-open and
pane -> history phases indistinguishable once two runs disturbed by the dev server are set aside
(`mls-ready` at 6.7 s in one). Not opened as a pull request. Unverified reason, the first thing to
check before trying again: the bench DM's bubbles are one line, so 24 groups may not fill the pane
and the fill loop widens back towards the old size, paying an extra layout pass on the way. The
patch is not kept; the two lines it changes are `INITIAL_RENDER_GROUPS` and the fill step in
`ChatArea.svelte`.

## iOS (iPhone 12) - NOT measured

The WebDriverAgent answered, but the installed build is a TestFlight build with no WebKit inspector
bridge (`pymobiledevice3 webinspector cdp --port 9444` was not running and a store build is not
inspectable), and the app was in the foreground in another session's hands. **Owed**: the same
four readings on a BENCH build (`ios.yml` with `local_url`, which adds `tauri/devtools`): `bun
tools/ios-device/ios.mjs terminate` then `url fr.emse.canari://chat/<groupId>` for the cold run,
`button home` then the same `url` for the warm one, with the boot bench and the console read over
the inspector bridge. The iOS path differs on two counts that may change the ranking: the tap
opens `userInfo["deepLink"]` written by the NSE ([mobile](mobile.md#what-each-notification-names-as-its-tap-target-and-who-routes-it-2026-10-05)),
and the unlock is the `.userPresence` keychain item unless the 12 h cadence applies.

## What the bench was left holding

The Mi 9T's `canari-test-delta` session on dev now has **"Rester connecte sur cet appareil"
ticked** (the vault path was measured by ticking it), and its one-member room `BenchR1` holds the
~17 `lat-*` markers the runs sent. Another session began driving the phone at ~20:34; every run in
the table was taken between 20:23 and 20:33, before it, and the one 60 s warm run that collided
was discarded.
