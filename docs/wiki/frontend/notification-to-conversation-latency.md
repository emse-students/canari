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

## The whole cycle, tap to delivered reply (2026-10-12)

**A second instrument, end to end on one clock.** `cycle.mjs` (scratch, not committed) sends the
message from the other account's dev tab (gamma, `chrome-w2`), fires the notification's exact
`PendingIntent` on the Mi 9T, waits for the composer, taps it for real, types a fixed marker with
`adb input text`, clicks send, and reads the reply's arrival on the sender's tab. The phone's epoch
and the workstation's are tied by an `adb shell date` round trip (skew error ~+-25 ms). Warm =
backgrounded for 6 s (a 1.5 s park, used before, let the feed's progressive mount resume under the
landing and polluted the reading). Killed = `force-stop`, then the PIN typed by the instrument.

**DEV HAS NO PUSH, so T1 (notification shown) is not measured**: `DEV_FIREBASE_SERVICE_ACCOUNT_JSON`
is absent ([dev-environment](../infrastructure/dev-environment.md)), so the tap is synthesised.
Two facts from the same session matter for a real tap: a FORCE-STOPPED app receives no FCM at all
(Android's stopped state) while a recents swipe does; and the delivery service holds a push 10 s
when the recipient's presence is alive (`scheduleDeferredPush`).

| ms after the tap, medians (n=6) | alpha warm | alpha killed | F1 warm | F1 killed |
| --- | ---: | ---: | ---: | ---: |
| app first line | - | 985 | - | 914 |
| deep link parsed | 496 [162-769] | 1226 | 314 [95-729] | 1180 |
| `MLS ready` (PIN typed in ~130 ms) | - | 2899 | - | 3000 |
| route is `/chat` | 1193 | 3121 | 900 | 1967 |
| composer usable | 1193 [709-1430] | 3632 [3529-3924] | 900 [752-1458] | 3586 [3301-4094] |
| the notified message's row drawn | 1882 | 4606 | 1628 | 4435 |
| send click -> outbox `sent` | +610 | +655 | +672 | +695 |
| send click -> on the other client | +558 | +601 | +625 | +661 |

`alpha` = `1.2.5-alpha.1`'s CI artifact, `F1` = PR #1770's (`0d7da4e6a`). What it says:

1. **The row the person tapped for comes 0.73-0.95 s AFTER the composer, in every column.** The
   stored page was drawn only after the server probe AND the replay behind it - a notification tap
   is precisely the case where the probe says "newer rows exist". **Fixed (F10, below).**
2. **Warm is ~1.2 s, not the <= 0.35 s recorded above** - that figure came from the 1.5 s park. The
   deep link itself is parsed 0.1-0.8 s after the tap, behind main-thread work (`import.then`, a
   ~0.95 s long frame on the first resume after an install).
3. **The PIN path is ~0.93 s in series** (salt 350, verifier 117, device id 44, check 253, device
   key 166) - F9.
4. **The send is ~0.65 s to the ack**: ~125 ms to the outbox (its durable write), ~55 ms to the
   flush, ~450 ms of flush (group meta pre-flight, encrypt, POST). The receiver has the message
   ~50 ms before the sender's outbox logs it.
5. **F1 routes ~1.15 s sooner when killed but the composer does not move** (3.63 -> 3.59 s): the
   pane still waits for `MLS ready`.

### F10 - the stored page is drawn before the server probe (measured: first row 773 -> 356 ms after the pane, killed)

`loadHistoryForConversation`'s fast path probes the server cursor (`limit=1`) and, when nothing is
newer, draws the stored page and stops. When something IS newer it went straight to the full replay,
and the stored page - already read - was drawn only by the replay's end. The page is now drawn
first; the replay merges what it adds into it (`mergeMessagePage`), so drawing first changes WHEN the
held rows appear, never which. That claim needs one more step than the merge: when the replay brings MORE than a page, the reloaded page no longer reaches the
early-drawn one, `mergeMessagePage` keeps memory outside its window, and the scrollback pages below
the OLDEST row in memory - so every stored row between the two windows would be hidden for good
(and an early-drawn row the replay edited would stay stale). The reload therefore withdraws the
early-drawn rows that fall below its window (`renderStoredPage`'s `supersedes`, logged as
`early-drawn row(s) ... withdrawn`), which gives the screen a load that never drew first gives.
A failed probe, previously swallowed, is logged.

| killed, PIN (Mi 9T, local APKs against dev, n=6 each) | `main` | F10 |
| --- | ---: | ---: |
| pane open -> first history row | **773** [669-1081] | **356** [349-364] |
| pane open -> the notified message's row | 1031 [902-1304] | 964 [914-1020] |

Warm, the rows are still in memory and appear with the pane on both builds, so F10 changes nothing
there. **What is left of the 356 ms** is the page read (~145 ms, `loadHistory start` -> page
rendered) and one ~320 ms long frame drawing 60 rows.

**The notified message itself is the next lever, and the trace names why it waits.** On a killed
open the WebSocket drain fetches it at ~3.35 s, ~0.45 s after `MLS ready`, and leaves it queued:
`[MLS] Message for absent conversation ... - retry after restore`. `loadExistingConversations`
inserts every conversation as a stub at once (its phase 1), but `notifyConversationsRestored` - the
trigger that re-fetches frames left behind as `absent-conversation` - fires only after its phase 2
(`getUserGroups`, the batch history, the per-conversation replay), at ~4.64 s. The message then
reaches the screen through the batch history's replay at ~4.55 s. Signalling availability once the
stub exists would make it readable ~1.2 s sooner, but phase 2 then rewrites the same conversation
entry, and whether that write can lose a message added in between has not been established - so it
is written down, not built.

### What is left after F9, F10 and F11, ranked by evidence (2026-10-12)

1. **The notified message waits for the end of the restore** (above): ~1.2 s on a killed open, the
   largest remaining gap for the row the person tapped for.
2. **Mounting the thread is ~0.3-0.35 s of main thread, warm or killed.** CPU profiles (CDP
   `Profiler`, 200 us sampling, one warm and one killed run): the longest busy stretch is the
   `/chat` route's Svelte flush (~190 ms warm) plus the layout it forces - `offsetHeight` read by
   the composer-height effect (~35-46 ms) and `scrollHeight` read by the thread's scroll anchoring
   (~40-55 ms), both simply the first layout of 60 freshly inserted rows (`insertBefore` ~44 ms
   self). The lever is mounting fewer rows first (the newest screenful, then the rest), not a
   single slow function.
3. **Every request to the estate costs ~150-250 ms from the phone against a 25 ms ping to the
   edge.** `tauri-plugin-http` 2.8.1 builds a new `reqwest` client per `fetch` (no connection
   reuse, read in its source), but that is NOT the cost: the same GET took 142-251 ms through the
   plugin and 237-389 ms through the WebView's own pooled `fetch` (`httpprobe`, n=8 each). The floor
   is the path behind the edge, an infrastructure question.
4. **Warm, the deep link is parsed 0.1-0.8 s after the tap** and the route renders behind it; the
   resume preparation (F5) is the same main thread.

**Instrument caveat**: the in-page recorder's PIN-gate predicate reads `document.body.innerText`
every 16 ms, which the profile shows costing ~100 ms of main thread inside the landing window. It
weighs on every build equally, so the comparisons hold, but absolute numbers are a little worse
than a person's.

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
