## P2 - push payloads carry nothing for Google and Apple (owner, recorded 2026-11-01; decided and built 2026-11-02, switch OFF)

Recorded from the owner's sovereignty philosophy ([durable-rules](../durable-rules.md#product-philosophy---sovereignty)).
Owner, 2026-11-02: build it, behind a SERVER-SIDE switch that is OFF by default, deterministic like
`calls_mode` - no timer, no fallback.

- **Before**: FCM and APNs see, per MLS frame, the conversation id, the sender id, the sender and
  group names on a visible frame, the conversation kind, the frame kind, the notification level and
  the inline ciphertext. Salon, social and call pushes (`sendPushToUser`) carry their own titles. The
  message content was already E2E. Source: [register-of-processing](../compliance/register-of-processing.md) section 8.
- **Goal**: a content-free wake-up push. The device fetches the rest from our server and decrypts it
  locally, as Signal does. Google and Apple then learn only "this device got a notification at this
  time", plus the one bit the platform itself needs (below).
- **APNs cannot be replaced on iOS** (only Apple can wake an iOS app). **Android beyond FCM**
  (UnifiedPush with a self-hosted distributor, or a persistent connection) is a separate question:
  ntfy would be an install on the DSI host, so their written agreement first; not part of this.

### The design (2026-11-02)

**Scope of step 1: the MLS frames** - every push `sendFcmForQueued` sends (messages, Welcomes,
commits, read receipts, own-device copies, Graine seeds). That is where the names and the
conversation graph were. **Step 2, not built: the internal pushes** (`sendPushToUser`: salons, social,
forms, the call ring). They have no durable server row to fetch by id, so a wake for them needs one
(an envelope table whose rows die with the fetch, and a retention answer for a device that never
fetches) - designed when step 1 has its readings.

**1. Two locks, ANDed, both deterministic.**

- `platform_config.push_mode` (core-service migration 018, edited at `/admin/platform`): `full`
  (the default - today's payloads) or `wake`. Read by chat-delivery-service on every MLS push that
  has a capable destination, never cached (`utils/push-mode.ts`, the twin of `calls-mode.ts`). An
  unreadable switch throws and that device's push is not sent - logged at error by the fan-out; the
  frame stays queued and is delivered at the next open. An absent row reads as `full` - not a
  guess: the value the row is CREATED with (the column default, core's `DEFAULT_ROW`), so the switch
  was never moved - and is accused at error ONCE PER PROCESS (`[PUSH_MODE]`), never once per push.
- `push_token.wakeCapable` (chat-delivery migration 045): the REGISTRATION says whether the binary
  understands a wake frame. Written on EVERY `POST /mls/push/register`, `false` when the body does not
  say `wake: true` - so an old build, and a downgrade, are never sent a frame they would drop. The
  web bundle is compiled into the store binary (`frontendDist`), so the TS that registers is always
  the same build as the native code that receives; `PUSH_WAKE_DECLARED` in `features.ts` says it,
  PER PLATFORM (`android: true`, `ios: false` - the owner's order, below).
  `registerPushToken` skips only within one process (sessionStorage), so an upgraded app writes the
  flag at its first start.

Wake is sent to a token only when `push_mode = wake` AND `wakeCapable`. Neither is a fallback for
the other: a `full` frame to an old build is the old build's contract, not a degraded path.

**2. What the wake push carries** (`buildWakeDataFields`, `buildWakeApnsRequest` in `push-payload.ts`):

| Field | Why it must travel |
| --- | --- |
| `type: 'wake'` | the discriminator every native dispatcher branches on |
| `queuedMessageId` | an opaque random UUID naming the device's own queued row - the fetch key. It names nobody and no conversation |
| `silent` | **the one bit the platform needs**: on iOS a silent frame MUST be `content-available` / `apns-push-type: background` and a visible one an alert, so Apple sees it anyway; on Android it decides whether a fetch failure owes a notification |
| `notifLevel: 'mentions'` | only on a visible frame of a conversation the recipient keeps at `mentions` (same key, same rule as the full map). A failed fetch cannot know whether the frame mentions them, so Android posts its failure notification SILENTLY - the bit Apple already reads as `passive` below. It names no conversation and no person |

**Removed from what Google and Apple see**: `groupId`, `senderId`, `senderName`, `groupName`,
`isGroup`, `isKeyDistribution`, `isWelcome`, `createdAt`, `proto`, and on iOS the
`thread-id` (the conversation id) and the sender-name title - the alert reads `Canari` / the localized
`Nouveau message`. **Kept on iOS, knowingly**: `interruption-level: passive` on a `mentions`
conversation's frame. It says "a quiet frame", not who or where, and without it a non-mention would
ring whenever the extension does not run.

**3. How each platform fetches.** `GET /api/mls/push/wake?messageId=&userId=&deviceId=&silent=`,
behind **`PushSecretGuard` then `PushSecretThrottlerGuard`**, like the key-group push routes: the
guard reads a GET's ids from its QUERY (never a merge with a body), and the throttler counts per
user, `WAKE_FETCH_LIMIT_PER_MINUTE = 600` - twice the 300 visible notifications a minute Android
posts at most per app (`MAX_PACKAGE_ENQUEUE_RATE` = 5/s), the other half for silent frames. The
secret is the one the app mirrors to the extension's App Group and to Android's Keystore and
`pending_push_secret.txt`; userId and deviceId are the device's own, read from its push context,
never from the push. A `messageId` that is not a uuid is a `400` before Postgres sees it. It
answers one of two typed bodies:

- `{status: 'frame', fields}` - EXACTLY the data map the full push would have carried
  (`buildPushDataFields`, one implementation), computed at fetch time by `describeQueuedFrame` - the
  same function the send path calls, in its `fetch` stage, which repeats none of the decision lines
  the send already logged - with the ciphertext always inline, read as `proto ?? content` exactly as
  the full push and `fetch-proto` read it, a legacy `content` row accused alike (no 4 KB budget on
  our own TLS; a Welcome still fetches its bundle through `fetch-proto`, which carries the ratchet
  tree).
- `{status: 'gone'}` - the row is not there: the app drained or ACKed it since. **An answer, not a
  failure**: nothing new is drawn on Android; the iOS extension, which cannot withhold an alert,
  makes it passive and says the message was already received.

Each native dispatcher then runs the fetched map through the path a full push takes - **no second
handler**: Android `onMessageReceived` -> `dispatchPush(fields)`; the iOS extension's `didReceive`
switch, re-entered with the fetched `userInfo`; the iOS app's `CanariHandleBackgroundFrame` for a
silent frame (its own-device dismissal needs `senderId`).

**4. When the fetch fails** (no push context, no secret, transport error, a non-200, a body that is
neither shape): **logged at error, tagged `[PUSH_WAKE]`, with the stage and the status**, and never
drawn as the generic text:

- Android, visible frame: a notification that SAYS the message could not be loaded and asks to open
  Canari (`notif_wake_unavailable`), on the messages channel, under ONE id for every failure
  (`WAKE_UNAVAILABLE_NOTIF_ID`: a burst is one notification, alerting once), and SILENT when the
  wake said `notifLevel: mentions`. Silent frame: the error line only - the
  frame stays queued and the next open drains it.
- iOS extension: the body becomes `notif.wake.unavailable` (same sentence), and the run's
  `[NSE_OUTCOME]` record is `fallback` with cause `wake-<stage>`, the stage that failed as a
  LETTER-ONLY token so it survives `is_code_token` (`wake-no-push-context`, `wake-no-id`,
  `wake-no-push-secret`, `wake-transport`, `wake-http-forbidden` / `-unauthorized` / `-throttled` /
  `-not-found` / `-bad-request` / `-server-error` / `-other`, `wake-unreadable-body`,
  `wake-frame-without-fields`, `wake-frame-without-type`, `wake-frame-is-a-wake`,
  `wake-unknown-status`), `kind=wake`. A FETCHED frame re-kinds the run (`Trace.rekind`) before it
  is dispatched, so `[NSE_OUTCOME]` keeps its `message` / `channel` split under wake mode. A `gone` answer is `server-content`, cause-free.
- iOS app, silent frame: the error line, no action (the dismissal it would have done is the one
  thing lost, and the next activation clears every conversation's notifications anyway).

No retry: one request. On iOS it is bounded by the transport's own timeout (5 s, as `fetch-proto`);
on Android a wake is bounded FROM ITS ARRIVAL: `WAKE_FETCH_DEADLINE_MS` = 20 s covers the wait for a
fetch thread, the DNS lookup (which `connectTimeout` does not cover), the connect and the last byte
(which `readTimeout`, per read, does not bound). Its ticket's deadline is scheduled when the push
arrives and settles the ticket as not loaded, logged at ERROR, whatever the fetch is doing - queued,
running or stuck; the fetch itself gets only what is left of the 20 s (none: not started), is
disconnected and abandoned when that runs out (`phase=connecting|awaiting-response|reading-body`),
and a result that comes back after its ticket was settled is dropped and logged. The fetch's wake
lock is its remaining budget plus 10 s. Every client asks
with caching off (`useCaches = false`, `reloadIgnoringLocalCacheData`), and the server answers
`Cache-Control: no-store`.

**On Android the fetch is OFF the MLS lane, and EVERY push reaches the lane in ARRIVAL order.** The
lane is the single writer of `mls.bin`, and its order is load-bearing: a key-group Welcome must be
joined before the salon push sealed on that group is opened (NOTIF-21), a commit applied before the
message sealed after it. A wake reaches the lane only once its fetch returns, so ordering the wakes
among themselves is not enough - a FULL `channel` push arriving after a Welcome sent as a wake would
overtake it. So every push bound for the lane takes a `WakeOrder` ticket on arrival: a full push's
is completed at once (`WakeOrder.inOrder`, inside `runSerializedWithWakeLock`), a wake's when its
fetch returns, and the lane is handed work only in ticket order. Work queued ON the lane (a frame
re-queued behind its Welcome) or from inside a release (the fetched frame's own dispatch) is
already in its turn and goes straight to the lane. New work a lane task spawns (a key-group join
queued behind its banner) takes a ticket like an arrival - the lane never waits on the order, a
ticket that cannot run yet is stored and run by the settlement that releases it - and only the
re-queue of the SAME frame behind its Welcome goes straight back. `WELCOMES_ON_LANE` is counted
right before the Welcome's task is handed to the lane, so it still means "on the lane".

**The bound, by construction**: every wake ticket is settled at most 20 s after it ARRIVED, so a
push - wake or full - is handed to the lane at most 20 s after the latest wake ahead of it arrived,
never "N stalled wakes times the fetch timeout" (four fetch threads, any queue length). The ticket
is also settled by the fetch's `finally`, or by the arrival thread if the fetch could not be
scheduled; an action that throws does not strand the ones behind it (`WakeOrderTest`, with the
clock as a recorder fired by hand, so no test asserts a wall clock).

The one "could not be loaded" notification is cancelled by id when the app comes to the foreground
(`cancelAllMessageNotifications`), and is not counted as an unread conversation. Its id, 9995, sits
with every other fixed notification id in `FixedNotifIds`, which the conversation-id counter
(`getStableNotifId`, from 1000, only growing) now steps over, so no conversation can be handed it.
The server writes `[PUSH_WAKE] served|gone` per fetch, so **sends with `mode=wake` minus fetches
served** is the population of wakes no device acted on - the one rate that says whether the switch
can stay on.

### How it interlocks with the P1 iOS-notifications entry

[p1-ios-notifications-show-no-content](p1-ios-notifications-show-no-content.md) is still measuring
whether the extension RUNS and decrypts on the bench and on a user's phone (`[NSE_OUTCOME]`,
`peakMB`, killed vs fallback). The wake mode makes the extension the ONLY source of content on iOS:
the server's alert no longer even names the sender, and a tap on a banner the extension did not
rewrite opens the app at the list (no `groupId` in clear for `CanariTapDeepLink`). So:

- **The owner's order (2026-11-02): ON on dev once the Mi 9T reading (row 1 below) passes, then ON
  in production FOR ANDROID ONLY until the P1 is closed.** "Android only" is not a server branch on
  the platform: it is the second lock. **An iOS build does not declare `wakeCapable`**
  (`PUSH_WAKE_DECLARED.ios` is false) until that entry is closed, so `push_mode = wake` wakes
  Android devices and every iPhone keeps the full push. Turning iOS on earlier would hide the P1
  measurement behind a second cause; turning it on is one constant and a store build.
- The wake path adds one fetch BEFORE the decrypt: its own `[NSE_OUTCOME]` stage is `wake-fetch`, so
  a kill or an expiry during it is attributed to it, not to the decrypt. The outcome log's contract
  (`commands/nse_outcomes.rs`, `nseOutcomes.ts`) is unchanged: `kind=wake` and the two new causes are
  code tokens it already accepts; the new stage is added to both stage lists.

### Where it stands (2026-11-02)

- Server half: #2915 (the switch, the capability column, the wake send, `GET /mls/push/wake`).
- Client half: the stacked draft after it (Android `onWakePush` + `WakeAnswer`, the iOS extension's
  `handleWake`, the iOS app's `CanariHandleWakeBackgroundFrame`, `PUSH_WAKE_DECLARED[platform]`
  sent as `wake` - `true` on Android, `false` on iOS until its P1 closes).
- **What is verified, and how**: the server by its jest suites; Android by compiling the app
  (`:app:compileArmDebugKotlin`) and the JVM `WakeAnswerTest`; the TS by vitest
  (`pushWakeCompiled.test.ts` reads the three native receivers as text). **The Swift and the
  Objective-C++ are not compiled by any pull-request job** - only a release's `ios.yml` builds them -
  and nothing native has RUN. The switch stays `full` until the readings below.

### Readings owed (the code is verified only by COMPILING, and iOS not even that before a release)

1. Dev estate, `push_mode = wake`, Mi 9T on a build carrying the client half: three texts (1:1,
   group, salon - the salon stays `full`, step 2), app backgrounded then killed. Each 1:1 and group
   banner shows the text; `adb logcat -s CanariFCM` shows `[PUSH_WAKE] fetched` before the decrypt;
   the server shows `mode=wake` sends and `[PUSH_WAKE] served`.
2. Same, iPhone 12, AFTER the P1 rows: banners with content, `[NSE_OUTCOME] kind=wake
   outcome=decrypted`, and an own-device read on another device clears the banner (the silent wake
   frame).
3. Airplane mode right after the send arrives (or the server stopped): Android shows the
   "could not be loaded" notification and `[PUSH_WAKE] ... failed` at error; iOS shows the same
   sentence and `outcome=fallback cause=wake-transport` (iOS: owed only once iOS declares the wake).
4. Production, a week with the switch on: `[PUSH_SEND] mode=wake` count against `[PUSH_WAKE] served`
   + `gone` - the gap is the wakes nobody fetched, per platform.
5. **Once on in production**, update the register (section 8) and the privacy policy together: what
   Google and Apple receive becomes "a wake-up and an opaque id" for conversations; salons and social
   stay as they are until step 2.
