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

### Noise seen on the way (not on the critical path, written down so it is not rediscovered)

- `[hooks] launch URL already acted on by this start, ignoring the replay` appears 2-4 times per
  cold start - the four `getCurrent()` re-reads, deduplicated as designed ([mobile](mobile.md)).
- `Warning: Cannot load system font: TimesNewRomanPS-BoldMT` twice after opening the conversation -
  a PDF in its history, rendered by the PDF viewer.
- The native HTTP client opens a NEW connection to the estate for each minute-spaced request
  (`reqwest::connect starting new connection` every 60 s while idle).

## The ranked fix plan

**Each line names its expected gain on THIS bench and the risk that decides whether it is worth
it.** Gains are not additive: 1 and 2 overlap.

| # | change | expected gain | risk |
| --- | --- | --- | --- |
| **F1** | **Route-first landing.** Route to `/chat` and select the target the moment the deep link is parsed (~1.25 s), drawing the conversation's shell (name, avatar, composer) before `MLS ready`; fill its history from the local store as soon as the device key is restored; a reply typed meanwhile goes to the outbox, which already holds sends until the session is up. Behind the PIN, the gate covers the target's page instead of the feed. | vault: usable at **~1.4-1.6 s instead of ~2.7 s**; PIN: the conversation is ALREADY there when the PIN is accepted (saves the ~0.95 s of block 5) | **medium-high**: `landingStep`'s `route -> await-arrival -> select` and the overlay/Back rules ([chat](modules/chat.md#and-the-re-verification-it-asked-for-says-the-mechanism-is-there-and-the-landing-destroys-it-2026-09-21)) must hold; the revocation gate must still precede anything that ACTS on the session ([cold-start](cold-start.md#the-revocation-gate-stays-in-front-of-the-prompt-and-the-launchs-console-noise-is-explained-pixel-6a-2026-09-15)) - drawing local history before the revocation answer (~110 ms on the vault path) is a decision for the user |
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
