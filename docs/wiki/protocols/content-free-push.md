# Content-free push - the whole design (2026-11-04)

**DESIGN ONLY for everything past step 1.** Owner, 2026-11-04: start with the design. Goal: what
Google (FCM) and Apple (APNs) receive is a wake-up and nothing they can read beyond it; the device
fetches the rest from our server over our own TLS, decrypts it locally and builds the notification
itself. The backlog entry is
[push-payloads-carry-nothing-for-google-and-apple](../backlog.d/push-payloads-carry-nothing-for-google-and-apple.md);
it keeps the mechanism of **step 1** (the MLS frames, built and merged in #2915, #2918, #2932, switch
`push_mode` OFF) and its five owed readings. This page is the rest: every push type measured from the
code, the target for each, the platform mechanics, the failure contract, calls, accounts, rollout,
cost, and the work packages in order. The why is the sovereignty rule
([durable-rules](../durable-rules.md#product-philosophy---sovereignty)).

## 1. What each push carries today, read from the code (2026-11-04, `main` at `ef1c3cdd3`)

Every push leaves through **chat-delivery-service**, the one process holding Firebase Admin. There
are four senders; the fields below are what FCM receives in `data` (Android) and what APNs receives in
the payload (iOS, the same map spread beside `aps`, because FCM does not merge `data` into an APNs
request).

| Push | Sender (file) | Fields Google / Apple read in clear | Step-1 wake? |
| --- | --- | --- | --- |
| **MLS frame** (DM, group, own-device copy, commit, Welcome, read receipt, Graine seed on a key group) | `sendFcmForQueued` -> `buildPushDataFields` / `buildApnsRequest` (`apps/chat-delivery-service/src/services/push-payload.ts`) | `type=message`, `groupId`, `queuedMessageId`, `senderId`, `senderName` + `groupName` (visible frames only), `isGroup`, `isKeyDistribution`, `proto` (the MLS ciphertext, when it fits 4 KB), `silent`, `notifLevel`, `isWelcome`, `createdAt`; iOS also the alert title (sender or group name) and `thread-id` (= `groupId`) | **yes** - `type=wake`, `queuedMessageId`, `silent`, `notifLevel` only, when `push_mode=wake` AND the token is `wakeCapable` |
| **Salon message** (community channel) | `notifyChannelRecipients` -> `sendInternalPush` (`apps/social-service/src/channels/channel.service.ts`) -> `POST /internal/push/notify` -> `sendPushToUser` | `type=channel`, `channelId`, `channelName`, `workspaceName`, `createdAt`, `senderSessionId`, `messageIndex`, `nonce`, `senderId`, `mentioned`, and the inline group `ciphertext` + `signature` + `seedFrame` + `seedGroupId` when it fits; the title `<community> - #<salon>` (iOS alert title, Android `title` field); iOS `thread-id` = `channel_<id>` | no |
| **Salon read** (`channel_read`, silent) | `markChannelRead`, `clearChannels` (same file) | `type=channel_read`, `channelId`, `workspaceId`, `senderId` (= the reader), and the salon name as `title` | no |
| **Social / bell** (posts, comments, mentions, reactions to posts, reposts, follow requests, lives, bookings, agenda, forms, Lydia, delegations - the 40 keys of `PushContentKey`) | `PushService.notifyContent` (`apps/social-service/src/push/push.service.ts`, keys in `push-content.ts`) | `type=social` or `form_reminder`, `contentKey`, `actorName` (a person's name), `contentArg` (**the opening of the text a person typed** for a comment, a reply, a mention or a post; an emoji; an event or form title; an association name; a booking place), `iconUserId` / `iconMediaId`, `deepLink` (names the post, form, live, association), the ids the caller adds (`postId`, `commentId`, `formId`, `liveId`, `associationId`, ...), and `title` / `body` = the French **legacy sentences** for clients before 2026-08-19 | no |
| **Reaction to a chat message** | `POST /mls/notify-reaction` (`messaging.controller.ts`) -> `sendPushToUser` | `type=social`, `reaction=true`, `groupId`, `messageId`, `emoji`, `senderId` (the actor), `deepLink` (`chat/<groupId>`); title = the actor's name, body = the French legacy sentence naming the actor and the emoji | no |
| **Join ask** (a person asks to join a group conversation) | `pushJoinAsk` (`utils/join-ask-announce.ts`, from `invitations.controller.ts`) -> `sendPushToUser` | the asker and the group, through the same `sendPushToUser` map | no |
| **Welcome request** (wake an elected member to admit a device) | `notifyWelcomeRequest` (`messaging.service.ts`) | `type=welcome_request`, the group and the requesting `user:device` | no |
| **Call ring** | `CallsService` (`calls.service.ts`): Android and VoIP-less iPhones through FCM (`ringViaFcm`), iPhones with a VoIP token through APNs VoIP direct (`apns-voip.service.ts`, `call-ring-payload.ts`) | ids only since decision 6: `type=call_ring`, `groupId`, `callId`, `callerId`, `hasVideo`, and on VoIP `ringUntil`; the FCM iOS alert is generic (`Canari` / `Appel entrant`) | no - and see section 6 |
| **Ring end** | `CallsService.endRing` | `type=call_ring_end`, `groupId`, `callId`, `reason` (silent / background) | no |

**What this tells Google and Apple, summed up:** for an MLS frame, who wrote to whom and in which
conversation, by name on a visible frame; for a salon, the community and salon names, the author id
and the ciphertext; for a social push, **the plaintext of what was written** (`contentArg` and the
legacy body carry the first 60 characters of a comment, a reply, a mention or a post) and the name of
who wrote it. Social text is not end-to-end encrypted at all (the server holds it), so for that class
the push is the ONLY place a third party reads it. The register's section 8 lists the same
([register-of-processing](../compliance/register-of-processing.md#8-processors-and-recipients)).

**The step-1 wake changes only the first row.** A device on `push_mode=wake` still sends every salon,
social, reaction, join-ask and call push in full - so the "Google and Apple see nothing" claim is
true for DMs and group conversations only, and the register update (reading 5 of the backlog entry)
must say so.

## 2. The target

ONE wake shape for everything that is not a call, extending step 1 rather than adding a second one:

| Field | Value | Why it must travel |
| --- | --- | --- |
| `type` | `wake` | the discriminator every native dispatcher already branches on |
| `queuedMessageId` (MLS) **or** `envelopeId` (everything else) | an opaque random UUID naming a row of THIS device | the fetch key; names nobody and no conversation |
| `silent` | `true` / `false` | the one bit the platform needs (iOS background vs alert; Android: whether a failure owes a notification) |
| `notifLevel` | `mentions`, only on a visible frame of a `mentions` conversation | so a failed fetch does not ring for what may not be a mention (iOS: `interruption-level: passive`) |

**Nothing else.** In particular not the push KIND (message / salon / social): a kind tells Apple and
Google "this person is being written to in a community" at a given time. The fetched answer says the
kind; the wake does not need it to choose a code path because the fetch IS the code path.

**On iOS the alert is `Canari` / the localized generic body** (`apnsFallbackBody`), no `thread-id`,
`mutable-content: 1`; the extension rewrites it from what it fetched. A silent wake is
`content-available: 1`, `apns-push-type: background`, as today.

**Calls are the one exception** (section 6): a ring must ring before any round trip.

## 3. Where the fetched content comes from

### 3.1 MLS frames - a durable row already exists (step 1, built)

`GET /api/mls/push/wake?messageId=&userId=&deviceId=&silent=` answers `{status: 'frame', fields}`
(the exact map `buildPushDataFields` would have sent, ciphertext always inline) or
`{status: 'gone'}`. Mechanism, guards and the 600/min/user throttle: the backlog entry.

### 3.2 Everything sent through `sendPushToUser` - no durable row exists, so one is written

Salon messages, salon reads, social and bell pushes, chat reactions and join asks have **no row a
device could name**: the salon message lives in social-service's `channel_messages` with no
per-recipient state, and a social push's text is composed at send time. Two ways to give the device
something to fetch:

- **(A, recommended) a push envelope in chat-delivery.** `sendPushToUser` already builds, per device,
  the exact map it hands FCM (`buildInternalAndroidHalf`) or APNs (`buildInternalApnsHalf`). In wake
  mode it builds the same map and STORES it instead of sending it, then sends the wake. The fetch
  answers that stored map; the native dispatcher runs it through the path a full push takes
  (`dispatchPush` on Android, the extension's `didReceive` switch on iOS) - **no second handler, no
  second builder**, the rule step 1 already follows. One implementation for 40+ push kinds and every
  future one.
- (B) a fetch route per kind, in the service that owns the data (a salon message by id from
  social-service, a bell row by id, ...). Rejected as the recommendation: N routes, N auth checks, and
  the native side learns N answer shapes; a new push kind would need a new route before it could go
  content-free, which is how a kind gets left behind.

**The envelope, concretely** (WP-W3):

- `push_body` - one row per SEND (one salon message, one social notification): `id`, the data map
  shared by every recipient (`jsonb`), `createdAt`. Salon ciphertexts and seed frames are stored ONCE,
  not once per recipient device.
- `push_envelope` - one row per DEVICE: `id` (random uuid, the `envelopeId` of the wake), `userId`,
  `deviceId`, `bodyId` (FK), the per-recipient overrides (`mentioned` today; the APNs locale-dependent
  fallback body is computed at fetch time from `push_token.locale`), `silent`, `createdAt`.
- `GET /api/mls/push/wake?envelopeId=&userId=&deviceId=` (the same route, the same `PushSecretGuard` /
  `PushSecretThrottlerGuard`, `Cache-Control: no-store`): found by `(id, userId, deviceId)` so a
  secret opens only its own rows; answers `{status: 'push', fields}` - the merged map, exactly what
  the full push would have carried, with NO 4 KB budget (the inline group always included) - or
  `{status: 'gone'}`. **The row is deleted by the answer that serves it** (one `DELETE ... RETURNING`,
  so two fetches of one envelope cannot both draw it), and its body with it when it was the last
  envelope (same transaction).
- **Retention by proof, never by a clock** (CLAUDE.md: termination from a proof): an envelope dies
  (1) when it is served; (2) when its device's `push_token` row is deleted (session end, revocation,
  invalid token - one `ON DELETE CASCADE` on `(userId, deviceId)`); (3) when the device REGISTERS
  (`POST /mls/push/register`, which every app start makes): an app that is open has the notifications
  list and the salon over HTTP, which are authoritative, so every envelope older than that
  registration is a banner for a phone that is now awake - deleted, counted in one line; (4) a
  per-device cap, `MAX_ENVELOPES_PER_DEVICE` (recommended 200: above Android's 300-per-minute
  notification ceiling split with silent frames, and far above any burst a closed phone legitimately
  accumulates), oldest out, accused at WARN `[PUSH_ENVELOPE] cap` with the count - a device that hits
  it is a device that never fetches, which is the population reading 4 wants named.
- **The send logs `[PUSH_SEND] mode=wake kind=<channel|social|...>` and the fetch
  `[PUSH_WAKE] served|gone envelope=...`**, so step 1's "sent minus served" ratio covers envelopes by
  the same `GROUP BY`.

### 3.3 What the server stores that it did not store before

The salon ciphertext and seed frame, until the device fetches them (they are already stored in
`channel_messages`; this is a second, short-lived copy), and the social sentence's data (`contentKey`,
`actorName`, `contentArg`), which social-service already holds in its notification rows. **Nothing a
third party sees grows; what the server holds grows by the envelopes in flight.** The register gets
one sentence: "the content of a notification is kept on our server until the device fetches it, at
most until the device next opens the app or signs out".

## 4. The platforms

### 4.1 Android (FCM data message)

- **Delivery.** A data-only message at `priority: high` wakes the app from Doze and runs
  `onMessageReceived` on a short exemption; the service has about 20 s before the system may kill it
  (FCM's documented bound; step 1 holds every wake to `WAKE_FETCH_DEADLINE_MS` = 20 s from arrival,
  in awake time, with its own wake lock). Longer work belongs on WorkManager (expedited), not in the
  service - nothing in this design needs it: one GET, then the existing decrypt.
- **Google's deprioritisation rule.** FCM documents that high-priority messages which do not result in
  a user-visible notification may be deprioritised. Today every frame is `high`, silent ones included
  (`sendFcmForQueued`, `sendPushToUser`), so this is not new to the wake - but a wake answered `gone`
  also draws nothing. **Measured, not assumed**: reading 4 already counts `gone`; a question below
  decides whether silent wakes go at `normal`.
- **App standby buckets.** A device in the `restricted` bucket receives a limited number of
  high-priority messages a day; past it they arrive as normal priority (delayed until a maintenance
  window). Unchanged by the wake; a wake that arrives late is fetched late and may answer `gone`,
  which is correct.
- **Ordering.** The wake fetch runs off the MLS lane and `WakeOrder` hands every push to the lane in
  ARRIVAL order (step 1). An envelope wake takes a ticket exactly like a frame wake: a salon push that
  arrives after the key-group Welcome it needs is still handed over after it (NOTIF-21).
- **No new permission, no foreground service.** The fetch is an HTTPS GET inside the existing
  exemption.

### 4.2 iOS (APNs alert + Notification Service Extension)

- **The extension exists** (`canari_NSE/NotificationService.swift`) and runs on every ALERT push with
  `mutable-content: 1`, out of process, for about 30 s (`serviceExtensionTimeWillExpire` then
  delivers whatever content is set). Its memory ceiling is not published by Apple; the widely
  observed figure is about 24 MB, and the extension's own `[NSE_OUTCOME]` record carries `peakMB` so
  the ceiling is MEASURED on our phones, not assumed. The wake adds one HTTPS GET before the decrypt,
  recorded as the stage `wake-fetch`, so a kill during it is attributed to it.
- **What the extension can read, already** (App Group `group.fr.emse.canari` + keychain access group,
  `canari_NSE.entitlements`): `push_context.json` (user, device, base URL), `push_secret.txt` (the
  fetch credential, written by the rotation's own writer), the `mls.bin` mirror (read-only),
  `graine_seeds.json` (sealed; only Rust opens it), `display_names.json`, and the device key from the
  shared keychain item (`AfterFirstUnlockThisDeviceOnly`). **Before the first unlock after a reboot
  the key is unreadable**: the fetch may succeed and the decrypt cannot - the run is `fallback`,
  cause `no-device-key`, as today.
- **iOS cannot withhold an alert.** Without the `com.apple.developer.usernotifications.filtering`
  entitlement (granted by Apple on request) the extension must deliver SOMETHING for every alert push.
  So a `gone` answer is drawn passive ("already received"), and a failure is drawn as the honest
  sentence. With the entitlement, `gone` could draw nothing at all - a question below.
- **Silent wakes are best effort**, as silent frames already are: `content-available` pushes are
  throttled by the system and not delivered to an app the user force-quit. Read receipts and
  own-device dismissals lose nothing new: the next activation clears every conversation's
  notifications.
- **The app-alive path** (`canari_push.mm`, `CanariHandleWakeBackgroundFrame`): a silent wake while
  the app runs in the background fetches, then dispatches as a full silent frame. Envelope wakes reuse
  it.
- **Not compiled by any pull-request job** - only a release's `ios.yml` builds the Swift and the
  ObjC++. Every iOS work package below depends on
  [the compile-only iOS job](../backlog.d/p2-pull-request-ci-never-compiles-ios-swift.md) existing
  first, or its gate is a release build.

## 5. When the fetch or the decrypt fails - the notification stays honest

The step-1 contract applies to envelopes unchanged, and it is the whole failure policy:

| What happened | Android | iOS extension | Log (accusing) |
| --- | --- | --- | --- |
| fetch failed (no context, no secret, transport, non-200, unreadable body, deadline) | visible wake: ONE notification under `WAKE_UNAVAILABLE_NOTIF_ID` saying the message could not be loaded and asking to open Canari (`notif_wake_unavailable`), silent when `notifLevel=mentions`; silent wake: nothing | body = `notif.wake.unavailable`, `[NSE_OUTCOME] outcome=fallback cause=wake-<stage>` | `[PUSH_WAKE] ... failed stage=<stage>` at ERROR |
| `gone` | nothing | passive "already received" (`server-content`) | server `[PUSH_WAKE] gone` |
| fetched, decrypt failed | the path a full push takes: its existing blind banner, `reportBlindBanner` counted | the existing MLS / salon ladder and its causes | the existing lines |

**The "could not be loaded" notification is NOT a fallback path.** It says what happened; it never
pretends to be the message, and every one is an ERROR line naming its stage. The rate that decides
whether the switch can stay on is `[PUSH_SEND] mode=wake` minus `[PUSH_WAKE] served|gone`, per
platform and per kind.

### 5.1 The Android salon banner that says "Quelqu'un" / "Nouveau message dans #x"

A parallel investigation is measuring why some Android community notifications show the generic line;
this page does not repeat it. From the code, the generic body and the unnamed author have separate
causes, and the wake touches them differently:

- **The inline group was not inlined** (`withInlineGroup`: ciphertext + signature + seed frame did not
  fit FCM's 4096 bytes with the fixed fields, logged `[PUSH_SIZE]`): the push carries no ciphertext,
  `handleChannelMessage` sees `openable=false`, and the banner is blind. **The wake removes this cause
  entirely** - our own TLS has no 4 KB budget, so the fetched map always carries the whole group.
- **The seed is absent** (no `graine_seeds.json` entry and no openable `seedFrame`: a sender older than
  section 19, a key group not joined on this device, a Welcome still behind) - **unchanged** by the
  wake; `WakeOrder` keeps the Welcome-before-salon order, so it does not get worse.
- **The author is unnamed** ("Quelqu'un" subtitle: a v1 session that proves no author, or
  `display_names.json` naming nobody for a proven author) - unchanged, unless the open question Q5
  below is taken: the fetched answer may carry the author's display name, used ONLY when the open
  proved that same `senderId`.

So the wake can only REMOVE a blind-banner cause; whatever the investigation finds for the other two
stays its own fix. The blind-banner counter must keep its `missing` reasons under wake mode (a
not-inlined reason should read zero on wake devices - that is the reading that proves this section).

## 6. Calls - the ring stays immediate

A ring cannot wait for a round trip:

- **iOS VoIP (PushKit)**: the app MUST report a CallKit call in `didReceiveIncomingPush` before its
  completion handler returns; an app that does not is terminated, and one that keeps failing stops
  receiving VoIP pushes. A fetch before the report is therefore forbidden by the platform.
- **Android**: the full-screen `CallStyle` notification is posted from `onMessageReceived`; a fetch
  first is up to 20 s of silence on a call that rings 60 s.

**What a ring tells Google and Apple today** is already names-free (decision 6): `callerId`,
`groupId`, `callId`, `hasVideo`, `ringUntil` - pseudonymous ids, but a call graph. **The target, a
later and separate step (WP-W6)**: ring with an opaque `ringId` and `ringUntil` only, report / post at
once with the neutral "Canari call", then fetch the ring (`GET .../ring?ringId=`) and UPDATE the call
(`CXProvider.reportCall(with:updated:)`; re-post the same Android notification id) with the caller's
name from the phone's own `display_names.json`. **If that fetch fails, the call cannot be answered**
(no `groupId` to join), so the ring is ended at once with an honest "could not be loaded" missed-call
line, logged at ERROR - never left ringing unanswerable. `call_ring_end` needs `callId` only (the
`groupId` it carries is not needed to end a ring by id) and can lose `groupId` first, cheaply.

Recommended order: calls go LAST, after the step-1 and envelope readings, because a CallKit regression
costs VoIP delivery for the whole app on a store build.

## 7. Several accounts on one device

- **One account owns an install's pushes at a time.** `push_context.json` names it; a signed-out device
  draws nothing (`PushRegistrationEnd.isSignedOut`); other accounts' MLS states are PARKED
  ([auth](../frontend/modules/auth.md#one-mls-state-per-account-on-a-native-install-owner-decision-2026-11-02)),
  and their push token rows are deleted when their session ends (`SessionPushEndService`).
- **A wake names no account, so the fetch asks as the account `push_context.json` names AT ARRIVAL**,
  and that account is bound to the wake's ticket. Two requirements for WP-W4 (Android) and WP-W5
  (iOS), checked by test:
  1. A wake for a previous account's token, arriving in the window before its token row is deleted,
     is fetched under the current account: the row is not found (`(id, userId, deviceId)`), the answer
     is `gone`, nothing is drawn. **Correct, and logged on the server as what it is**: when the id
     exists under ANOTHER recipient, the server writes `[PUSH_WAKE] foreign` (the device still receives
     only `gone` - it must not learn another account's rows exist).
  2. An account switch between a wake's arrival and its dispatch: the dispatch checks, under the state
     lock, that the slot's owner record still names the ticket's account (the check
     `slot_is_accounts_held` already makes for a key-group join) and drops the fetched map otherwise,
     at WARN `[PUSH_WAKE] account-switched`, no banner. Without it, account A's frame would be
     decrypted against B's state and drawn as a blind banner on B's phone.
- **The Graine seed and channel-key caches are not per account**
  ([p3-label-push-caches-by-account](../backlog.d/p3-label-push-caches-by-account.md)). The wake reads
  them exactly as a full push does, so it neither fixes nor worsens that entry; the two are
  independent and can land in either order.

## 8. Rollout, and old clients

- **Two locks, ANDed, unchanged**: the estate's `platform_config.push_mode` and the token's
  capability. **The capability becomes a VERSION** (`push_token.wakeVersion` int: 0 none, 1 MLS frames
  - today's `wakeCapable = true` - , 2 envelopes), written on every register from
  `PUSH_WAKE_DECLARED[platform]`. An envelope wake goes only to `wakeVersion >= 2`; a step-1 build
  keeps receiving full salon and social pushes, never a wake it would drop. (A second boolean would do
  the same and leave a third the day calls join; a version does not.)
- **Order, as the owner set it on 2026-11-02**: Android first, on dev, then production; iOS declares
  only once its extension readings are taken. The iOS constant stays `false` until then.
- **Legacy rows** ([legacy-compatibility](../legacy-compatibility.md)): the `legacyTitle` /
  `legacyBody` shim and the reaction's `social` wire type stay for every full-mode device; a wake
  device never receives them. **The `full` path itself becomes a legacy row** the day both platforms
  declare version 2: its removal condition is `minClientVersion` on an estate at or above the first
  build declaring it on both platforms, and `push_mode = wake` on that estate - then the full builders,
  the switch and the shim rows go in one pull request.
- **Web push**: none exists (the web client is notified over its WebSocket only); nothing to migrate.

## 9. Server cost

- **Per visible push, one extra HTTPS request per device** through nginx to chat-delivery, guarded by
  `PushSecretGuard` (an HMAC compare) and one indexed lookup by primary key; per envelope push, one
  INSERT at send and one `DELETE ... RETURNING` at fetch, plus one INSERT of the shared body per send.
- **Volume = push volume**, which the logs already count: `[PUSH_SEND]` lines (MLS) and
  `[SOCIAL_PUSH] ... sent` (everything through `sendPushToUser`) per day. **Owed before WP-W3 merges,
  read on production**: those two counts per day and per hour of peak, and the p95 salon fan-out
  (`[CHANNEL_PUSH] ... recipients=N`) - the size of the largest burst of envelope inserts one salon
  message causes. Not guessed here.
- **Storage**: envelopes live until fetched, opened or capped; the shared body holds a salon
  ciphertext once per message. The steady state is the backlog of closed phones, bounded by the cap.
- **Throttle**: step 1's 600 fetches per minute per user per replica covers envelopes too; a salon
  burst that exceeds it on one device is a `throttled` stage, accused, and the next open shows
  everything.

## 10. Work packages, in order, each with its gate

| # | Work package | Gate (what must pass before it merges / turns on) |
| --- | --- | --- |
| WP-W0 | Step 1, built (#2915, #2918, #2932) | the backlog entry's readings 1-5 |
| WP-W1 | `push_mode = wake` on dev, Android | reading 1 (Mi 9T, three texts, backgrounded then killed) and reading 3 (airplane mode -> the honest notification + `[PUSH_WAKE] ... failed`) |
| WP-W2 | `push_mode = wake` on production (Android declares, iOS does not) | WP-W1 read; then reading 4 for a week: every unfetched wake explained by a typed stage; the register + privacy policy line for MLS frames (reading 5) in the same change |
| WP-W3 | Server: `push_body` + `push_envelope`, `wakeVersion`, `sendPushToUser` stores and wakes when `push_mode = wake` and `wakeVersion >= 2`, the fetch answers `{status: 'push'}` | jest: the fetched map is byte-identical to the map the full push would have sent for the same input (salon, social, reaction, read, join ask); a second fetch of one envelope is `gone`; the four retention deaths each delete exactly their rows (cascade, register, cap, serve); `foreign` logged and answered `gone`; the production volume counts of section 9 read and written here |
| WP-W4 | Android: envelope wakes (`envelopeId` -> fetch -> `dispatchPush`), the account bound at arrival and checked at dispatch, `PUSH_WAKE_DECLARED.android = 2` | `:app:compileArmDebugKotlin`; JVM tests (`WakeAnswerTest` for `push`, `WakeOrderTest` for an envelope ticket between a Welcome and its salon, a switch between arrival and dispatch); vitest `pushWakeCompiled.test.ts` extended; then on the Mi 9T: a salon text, a comment, a chat reaction, each with content; the blind-banner `not-inlined` reason reads zero on wake |
| WP-W5 | iOS: envelope wakes in the extension and in `canari_push.mm`, the account check, `PUSH_WAKE_DECLARED.ios = 2` | the compile-only iOS job ([p2](../backlog.d/p2-pull-request-ci-never-compiles-ios-swift.md)) green; iPhone 12: reading 2 of the backlog entry for DMs, then salons and social, `[NSE_OUTCOME] kind=wake outcome=decrypted`, `peakMB` read for the largest salon |
| WP-W6 | Calls: `call_ring_end` loses `groupId`; then the opaque `ringId` ring with the update after report | the first half: specs + one ring end read on both phones; the second half: a decision (question N2 below) and a ring read on both phones, locked and killed, including a failed fetch |
| WP-W7 | Retire the `full` path once both platforms declare 2 and `minClientVersion` passes them; the register and the privacy policy say "a wake-up and an opaque id" for every push but a ring | `legacy-compatibility.md` row met on the estate (`GET /api/version`); the full builders, `push_mode` and the legacy-sentence shim deleted in one pull request |

## 11. Open questions

### Reversible - the recommended option is taken unless the owner says otherwise

| # | Question | Recommended |
| --- | --- | --- |
| Q1 | How a non-MLS push gets something to fetch | the envelope in chat-delivery (3.2 A), one implementation for every kind |
| Q2 | One envelope per device holding the whole map, or a shared body + per-device envelopes | shared body: a salon ciphertext stored once per message, not once per device |
| Q3 | How an unfetched envelope dies, with no clock | served, token deleted, device registers (app open), per-device cap of 200 oldest-out at WARN |
| Q4 | The capability: a second boolean or a version | `push_token.wakeVersion` int, `wakeCapable` migrated to `1` |
| Q5 | Should a fetched salon answer carry the author's display name | yes, keyed by `senderId`, drawn ONLY when the open proved that author; it removes the `no-names` cause of "Quelqu'un" without trusting the server's claim of authorship. Taken only if the parallel investigation finds `no-names` among the measured causes |
| Q6 | Silent wakes at FCM `normal` priority instead of `high` (deprioritisation of high-priority pushes that draw nothing) | keep `high` and measure: `gone` and silent wake counts per day in reading 4; change only on a measured deprioritisation |
| Q7 | What the production flip of WP-W2 waits for | every unfetched wake explained by a typed stage for a week, and the "could not be loaded" notification on under 1 % of visible wakes |

### Not reversible, or not ours - parked in [open-questions](../open-questions.md#content-free-push---the-three-decisions-that-are-not-reversible-2026-11-04)

| # | Question | Why it is not a reversible default |
| --- | --- | --- |
| N1 | Ask Apple for the notification-filtering entitlement, so a `gone` wake draws nothing on iOS | a request to Apple tied to the App ID, answered by Apple; a one-off for the owner |
| N2 | Calls through a fetch (the opaque `ringId` ring) | a CallKit regression on a store build costs VoIP delivery for the whole app, and old builds ring with ids for as long as they live |
| N3 | Retiring the full path (WP-W7) | raising `minClientVersion` forces every older install to update before it gets any notification |

Android beyond FCM (UnifiedPush with a self-hosted distributor) stays out of this design: it is an
install on the shared host, so the host owner's written agreement comes first (backlog entry).
