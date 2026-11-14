# Content-free push - the whole design (2026-11-04)

**Step 1 built (switch OFF); WP-W3, the server half of step 2 (the envelope), built 2026-11-07
behind the same switch and inert until a client declares version 2 (WP-W4); everything else is
design.** Owner, 2026-11-04: start with the design. Goal: what
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
are **six send sites**: `sendFcmForQueued` (MLS frames), `sendPushToUser` (everything other services
and the reaction / join-ask routes ask for), `sendFcmWelcomeRequestPending`, and in `calls.service.ts`
the FCM ring (`ringViaFcm`), the APNs VoIP ring (`apns-voip.service.ts`) and the ring end. The fields
below are what FCM receives in `data` (Android) and what APNs receives in the payload (iOS: each
sender spreads the same fields beside `aps` ITSELF). **Whether FCM also copies the top-level `data`
map into the APNs payload is asserted both ways in the code** - `buildInternalApnsRequest`'s comment
says it does not, `ringViaFcm`'s says it does - and neither has been measured. No design here depends
on the answer: every target payload below sends the SAME minimal fields in `data` and beside `aps`,
so either reading leaks nothing more.

| Push | Sender (file) | Fields Google / Apple read in clear | Step-1 wake? |
| --- | --- | --- | --- |
| **MLS frame** (DM, group, own-device copy, commit, Welcome, read receipt, Graine seed on a key group) | `sendFcmForQueued` -> `buildPushDataFields` / `buildApnsRequest` (`apps/chat-delivery-service/src/services/push-payload.ts`) | `type=message`, `groupId`, `queuedMessageId`, `senderId`, `senderName` + `groupName` (visible frames only), `isGroup`, `isKeyDistribution`, `proto` (the MLS ciphertext, when it fits 4 KB), `silent`, `notifLevel`, `isWelcome`, `createdAt`; iOS also the alert title (sender or group name) and `thread-id` (= `groupId`) | **yes** - `type=wake`, `queuedMessageId`, `silent`, `notifLevel` only, when `push_mode=wake` AND the token is `wakeCapable` |
| **Salon message** (community channel) | `notifyChannelRecipients` -> `sendInternalPush` (`apps/social-service/src/channels/channel.service.ts`) -> `POST /internal/push/notify` -> `sendPushToUser` | `type=channel`, `channelId`, `channelName`, `workspaceName`, `createdAt`, `senderSessionId`, `messageIndex`, `nonce`, `senderId`, `mentioned`, and the inline group `ciphertext` + `signature` + `seedFrame` + `seedGroupId` when it fits; the title `<community> - #<salon>` (iOS alert title, Android `title` field); iOS `thread-id` = `channel_<id>` | no |
| **Salon read** (`channel_read`, silent) | `markChannelRead`, `clearChannels` (same file) | `type=channel_read`, `channelId`, `workspaceId`, `senderId` (= the reader), and the salon name as `title` | no |
| **Social / bell** (posts, comments, mentions, reactions to posts, reposts, follow requests, lives, bookings, agenda, forms, Lydia, delegations - the 40 keys of `PushContentKey`) | `PushService.notifyContent` (`apps/social-service/src/push/push.service.ts`, keys in `push-content.ts`) | `type=social` or `form_reminder`, `contentKey`, `actorName` (a person's name), `contentArg` (**the opening of the text a person typed** for a comment, a reply, a mention or a post; an emoji; an event or form title; an association name; a booking place), `iconUserId` / `iconMediaId`, `deepLink` (names the post, form, live, association), the ids the caller adds (`postId`, `commentId`, `formId`, `liveId`, `associationId`, ...), and `title` / `body` = the French **legacy sentences** for clients before 2026-08-19 | no |
| **Reaction to a chat message** | `POST /mls/notify-reaction` (`messaging.controller.ts`) -> `sendPushToUser` | `type=social`, `reaction=true`, `groupId`, `messageId`, `emoji`, `senderId` (the actor), `deepLink` (`chat/<groupId>`); title = the actor's name, body = the French legacy sentence naming the actor and the emoji | no |
| **Join ask** (a person asks to join a group conversation) | `pushJoinAsk` (`utils/join-ask-announce.ts`, from `invitations.controller.ts`) -> `sendPushToUser` | `type=social`, `contentKey` (the join-ask key), `actorName` (the asker's name), `contentArg` (the group's name), `deepLink` (`chat/<groupId>`), `groupId`, `senderId` (the asker); title = the asker's name, body = the French legacy sentence naming the asker and the group | no |
| **Welcome request pending** (wake the other members so one of them admits a device) | `sendFcmWelcomeRequestPending` (`messaging.service.ts`, its own direct `getMessaging().send`) - `notifyWelcomeRequest` itself is a WebSocket signal | `type=welcome_request_pending`, `groupId`, `requesterUserId`, `requesterDeviceId`; Android high priority, iOS a background push (`content-available`), to every token of every other member | no |
| **Call ring** | `CallsService` (`calls.service.ts`): Android and VoIP-less iPhones through FCM (`ringViaFcm`), iPhones with a VoIP token through APNs VoIP direct (`apns-voip.service.ts`, `call-ring-payload.ts`) | ids only since decision 6: `type=call_ring`, `groupId`, `callId`, `callerId`, `hasVideo`, and on VoIP `ringUntil`; the FCM iOS alert is generic (`Canari` / `Appel entrant`) | no - and see section 6 |
| **Ring end** | `CallsService.endRing` | `type=call_ring_end`, `groupId`, `callId`, `reason` (`cancelled`, `answered` or `ended`); silent / background, to EVERY token of EVERY admitted member | no |

**On iOS the legacy sentences are what the lock screen shows when the extension does not run**: for a
social push, a reaction and a join ask, `title` / `body` are the visible `aps.alert`
(`buildInternalApnsRequest`), not only data fields - so the plaintext opening of a comment is in the
alert itself.

**What this tells Google and Apple, summed up:** for an MLS frame, who wrote to whom and in which
conversation, by name on a visible frame; for a salon, the community and salon names, the author id
and the ciphertext; for a social push, **the plaintext of what was written** (`contentArg` and the
legacy body carry the first 60 characters of a comment, a reply, a mention or a post) and the name of
who wrote it. Social text is not end-to-end encrypted at all (the server holds it), so for that class
the push is the ONLY place a third party reads it. The register's section 8 lists the same
([register-of-processing](../compliance/register-of-processing.md#8-processors-and-recipients)).

**The step-1 wake changes only the first row.** A device on `push_mode=wake` still receives every
salon, social, reaction, join-ask, welcome-request-pending and call push in full - so the "Google and Apple see nothing" claim is
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

**The welcome-request-pending push becomes a silent envelope wake** (WP-W3b). It carries no text, but
`groupId` + `requesterUserId` + `requesterDeviceId` tell Google and Apple that a given person's new
device is joining a given conversation, sent to every other member. It has no durable row either, so
it goes through the same envelope as `sendPushToUser` (section 3.2): `sendFcmWelcomeRequestPending`
stops calling `getMessaging()` itself and stores its map, then sends a silent wake. The receiver
already only reconnects its WebSocket on it, so the fetched fields change nothing in what it does.

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
  (`dispatchPush` on Android, the extension's `didReceive` switch on iOS) - **no second handler**,
  the rule step 1 already follows. One implementation for 40+ push kinds and every future one.
- **The iOS presentation is NOT in the data map today, so the answer must carry it.**
  `buildInternalApnsRequest` decides three things OUTSIDE the map, in the `aps` block: the
  `thread-id` (`channel_<id>`, the conversation of a reaction, `post_reaction_<id>`, `canari_forms`,
  `canari_social`), the `sound` (`internalApnsSound`: mention / message / reaction / default) and,
  for a silent push, the background type. A wake's alert carries none of them (they would name the
  conversation), and the extension today keeps the server's `thread-id` and sound for every kind it
  does not rewrite - so a fetched map without them would file every social and reaction banner under
  no thread and play the default sound: **a grouping regression in WP-W5**. So the server computes
  them ONCE, with the functions that compute them today, and the answer carries them as
  `presentation: {threadId, sound, interruptionLevel}`; the extension (and `canari_push.mm`) apply
  them to the content it delivers. The `apns-push-type`/priority need no carriage: the wake already
  chose them from `silent`. The step-1 MLS answer gets the same three fields (`buildApnsRequest`
  decides them for a frame too), so WP-W5 applies one rule to both kinds of wake.
- (B) a fetch route per kind, in the service that owns the data (a salon message by id from
  social-service, a bell row by id, ...). Rejected as the recommendation: N routes, N auth checks, and
  the native side learns N answer shapes; a new push kind would need a new route before it could go
  content-free, which is how a kind gets left behind.

**The envelope, concretely** (WP-W3, BUILT 2026-11-07 - chat-delivery migration
`046_push_envelope.sql`, `utils/push-envelope.ts`, `PushEnvelope`; the switch stays `full` and no
client declares version 2 yet, so nothing writes an envelope until WP-W4 ships and the switch moves):

- **ONE table, `push_envelope`, one row per DEVICE - not the `push_body` + `push_envelope` pair
  designed first** (Q2, revised when it was built): `id` (random uuid, the `envelopeId` of the wake),
  `userId`, `deviceId`, `payload` (`jsonb`: the caller's `title`, `body`, `data` - the server-only
  `minAppVersion` floor removed - and `inline`), `silent`, `collapseKey`, `createdAt`, `servedAt`,
  `servedCount`; a foreign key `(userId, deviceId)` -> `push_token` `ON DELETE CASCADE`. **Why the
  shared body was dropped**: a "send" here is ONE `sendPushToUser` call, and that call is ONE
  recipient account - social-service's salon fan-out calls `POST /internal/push/notify` once per
  recipient. So a shared body could only ever be shared by ONE account's devices (one or two), never
  by a salon's members; it bought almost nothing, and it cost an orphan-body sweep, a trigger on the
  cascade path (which the migration judge holds, since its body is a `DELETE FROM`) and a
  lock-ordering argument for two concurrent deletions. With one table nothing can be orphaned, and
  the three deaths are one cascade and two `DELETE`s. There are no per-recipient overrides either:
  `mentioned` is already in that one account's data map. If the fan-out ever becomes one call per
  salon message, storing its ciphertext once is a new table and a reversible change - measured first
  by section 9's fan-out reading.
- `GET /api/mls/push/wake?envelopeId=&userId=&deviceId=` (the same route, the same `PushSecretGuard` /
  `PushSecretThrottlerGuard`, `Cache-Control: no-store`; naming both `messageId` and `envelopeId` is a
  `400`): found by `(id, userId, deviceId)` so a secret opens only its own rows; answers
  `{status: 'push', fields, presentation}` - exactly what the full push would have handed THIS
  device's platform (`buildEnvelopeAnswer`: Android the data map with `title` and `body`, iOS the
  custom keys beside `aps`), with NO 4 KB budget (the inline group always included) - or
  `{status: 'gone'}`. The platform and locale are read with the envelope, from the device's own
  `push_token` row, in one statement.
- **`presentation` is `{title, body, threadId, sound?, interruptionLevel?}`**, read out of the full
  push's APNs request by `presentationOf` (null for a background push) - the three fields designed
  above PLUS the alert's title and body: the extension keeps the server's alert text for every kind
  it does not rewrite (a social push, a reaction), and a wake's alert is the generic `Canari` line, so
  without them those banners would lose their text, not only their thread. The step-1 MLS answer
  carries it too (`buildWakeFrameAnswer`, the device's locale read for the fallback body). Readers
  that predate the key ignore it (Android `WakeAnswer` and the two iOS readers read named keys only).
- **The legacy `title` / `body` sentences ride in the answer** (Android's data map carries them
  today), so the answer stays the same key/value set as the full push. They now cross only our own TLS; they
  leave with the legacy-sentence shim (WP-W7), not here.
- **Every wake plays the same sound** (`IOS_NOTIFICATION_SOUND.message`): a sound chosen per kind
  would tell Apple the kind. The extension applies `presentation.sound` once it runs.
- **Serving does not delete - it marks `servedAt` and answers the same map again to the same device.**
  A delete-on-serve would turn a lost response (the connection cut after the server answered, the
  process killed before it read the body, the 20 s deadline firing) into a retry answered `gone` and
  counted as served: a lost notification the ratio calls a success. Instead the envelope stays, a
  second fetch of it is served the same map (and logged `[PUSH_WAKE] served again envelope=...
  times=<n>`), and **the device deduplicates by notification identity = `envelopeId`** (Android: the
  notification tag; iOS: the content's identifier), so a repeat redraws the same banner and never
  adds one. This is also what the step-1 MLS fetch already does: the queued row dies by its ACK, never
  by being served. The ratio becomes "sends minus envelopes with a `servedAt`", which a lost response
  no longer falsifies.
- **Retention by proof, never by a clock** (CLAUDE.md: termination from a proof). An envelope dies
  only by one of three proofs and one bound: (1) its device's `push_token` row is deleted (session
  end, revocation, invalid token - one `ON DELETE CASCADE` on `(userId, deviceId)`); (2) **the app is
  opened - "register" means exactly this**: every app process calls `POST /mls/push/register` once at
  its start (`registerPushToken` skips repeats within one process, so a return to the foreground of a
  live process does not register, and its envelopes wait for the next start or the cap). An app that
  is open has the notifications list and the salons over HTTP, which are authoritative - so every
  envelope of that device is a banner for a phone that is now awake: all of them are deleted (no
  timestamp comparison: one written while the registration runs is for an open app too), counted in
  one line (`[PUSH_ENVELOPE] register swept=<n>`); (3) the per-device cap
  `MAX_ENVELOPES_PER_DEVICE` (recommended 200), **served envelopes evicted first** (the device
  already drew them; they stay only so a lost response can be fetched again), **then silent ones** (a
  silent push draws nothing, so it is worth less than any banner - but it is NOT merely superseded:
  same-salon `channel_read` envelopes already collapse to the newest at insert, so an evicted one is
  the only pending read of its salon, or another silent kind), then the oldest visible ones. Each
  eviction line carries the three counts (served, unserved silent, unserved visible), at the level
  its loss earns: an unserved banner is accused at WARN `[PUSH_ENVELOPE] cap` (a device that never
  fetches); an unserved silent one is logged at log level `[PUSH_ENVELOPE] cap silent` (a stale salon
  badge until the app opens - a rate to read, nothing the user misses); served ones alone are the
  cap's ordinary turnover on a device that fetches, at debug - a WARN there would fire on every
  healthy device past 200 pushes since its last app start. The number 200 is not derived from a platform rate: it is
  four times the 50 notifications Android lets one app keep active (beyond which the system refuses
  the app's new posts), so a device at the cap holds more banners than it could ever show - it is a
  device that never fetches, the population reading 4 wants named. Android also limits how many
  notification updates an app may enqueue per second (`MAX_PACKAGE_ENQUEUE_RATE`, 5), which is why a
  burst of fetched envelopes is drawn through the existing lane, one at a time.
- **As built**: the collapse, the insert and the cap run in ONE transaction per send
  (`storeEnvelopes`), committed BEFORE any wake leaves, so a device that fetches at once finds its
  envelope. A device whose new envelope the cap takes at once (a silent push on a device full of
  banners) is not woken. **The transaction opens by locking the account's registration rows for
  those devices** (`SELECT ... FOR NO KEY UPDATE`, ordered by `deviceId` so two sends never
  deadlock): (a) a registration deleted between the send's token read and the insert is simply not
  returned, so that device is reported `registration-gone` (logged `[PUSH_ENVELOPE] registration
  gone`, not woken, not a failure) instead of failing the foreign key and rolling back every OTHER
  device's envelope; (b) two sends to one device are serialised, so the collapse and the cap count
  rows the other has committed - without it both could insert past the cap or keep two read
  envelopes of one salon. The lock is the weakest that conflicts with a delete, so a concurrent
  token refresh is not blocked. Both are proven against PostgreSQL with a second session holding the
  row (`046_push_envelope.integration.spec.ts`). **Every multi-row writer of `push_token` takes the
  same order**: the account erasure (`deleteAccountPushTokens`, from `InternalController`) locks the
  account's rows `ORDER BY "deviceId" FOR UPDATE` before its delete, because a bare
  `DELETE ... WHERE "userId"` locks in scan order and deadlocks against a store holding one device and
  waiting for another - proven by the same spec, with the erasure's session denied every index so its
  scan meets the rows out of `deviceId` order (it fails `deadlock detected` without the lock). The registration sweep is `sweepDeviceEnvelopes`, called after the upsert of
  `POST /mls/push/register`; its failure is accused at ERROR and never fails the registration (the
  device must still get its secret).
- **What a wake that cannot be prepared does**: the switch unreadable, or the envelopes not stored
  (a registration deleted between the token read and the insert fails the foreign key) - those
  devices are sent NOTHING, accused at ERROR (`[SOCIAL_PUSH] push_mode unreadable`,
  `[PUSH_ENVELOPE] store failed`), counted `failed`. Never the full push in their place: that would
  hand Google and Apple exactly what the switch withholds. A token below version 2 is untouched.
- **The send logs `[SOCIAL_PUSH] sent ... mode=wake kind=<data.type> envelope=<8>`** (and every full
  send now says `mode=full`), **the fetch `[PUSH_WAKE] served|served again times=<n>|gone|foreign
  envelope=<8>`**, so step 1's "sent minus served" ratio covers envelopes by the same `GROUP BY`,
  and section 8.1's send reading is the `mode=` split of `[SOCIAL_PUSH] sent`.
- **Open for WP-W5, not for WP-W4: a background launch of the iOS app must not register.** The sweep
  is right because a registration means "the app is open". On Android a push never starts the
  WebView (the FCM service runs without `MainActivity`), so `registerPushToken` runs only when the
  app opens. On iOS a silent push can launch the app process in the background; if that launch runs
  the web layer's `registerPushToken`, it would sweep envelopes the extension has not fetched yet
  (answered `gone`, drawn "already received"). WP-W5 must read whether it does, on the iPhone 12,
  before iOS declares version 2.

### 3.3 What the server stores that it did not store before

The salon ciphertext and seed frame, until the device next opens the app (they are already stored in
`channel_messages`; this is a second, short-lived copy), and the social sentence's data (`contentKey`,
`actorName`, `contentArg`), which social-service already holds in its notification rows. **Nothing a
third party sees grows; what the server holds grows by the envelopes in flight.** The register gets
one sentence: "the content of a notification is kept on our server until the device next opens the
app or signs out" - true as written, since serving does not delete.

## 4. The platforms

### 4.1 Android (FCM data message)

- **Delivery.** A data-only message at `priority: high` wakes the app from Doze and runs
  `onMessageReceived` on a short exemption from background limits. How long that exemption lasts is
  the platform's, not ours, and Google's own guidance has stated different figures over time (on the
  order of ten to twenty seconds) - so nothing here relies on an exact number: step 1 bounds every wake
  by its OWN deadline, `WAKE_FETCH_DEADLINE_MS` = 20 s from arrival in awake time, holds its own wake
  lock while the fetch runs, and a kill before that is a fetch whose ticket never settled - its frame
  stays queued for the next open. Longer work belongs on WorkManager (expedited), not in the
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
  NOTHING of this is readable** - not the key, and not the App Group files either (`push_context.json`,
  `push_secret.txt` are protected until first unlock by default). So the wake fails BEFORE its fetch,
  with the cause `wake-no-push-context` or `wake-no-push-secret`, and the run draws the honest "could
  not be loaded" sentence. Expected for that window, and attributable: a reader of `[NSE_OUTCOME]`
  separates it from a real context loss only if the run says WHY the read failed (owed in WP-W5: the
  extension records whether the read was refused by data protection - the file exists but cannot be
  opened - or the file is absent).
- **iOS cannot withhold an alert.** Without the `com.apple.developer.usernotifications.filtering`
  entitlement (granted by Apple on request) the extension must deliver SOMETHING for every alert push.
  So a `gone` answer is drawn passive ("already received"), and a failure is drawn as the honest
  sentence. **Owner, 2026-11-04 (N1): no request to Apple for that entitlement** - iOS keeps drawing an
  honest alert for every wake (section 11).
- **Silent wakes are best effort**, as silent frames already are: `content-available` pushes are
  throttled by the system and not delivered to an app the user force-quit. Read receipts and
  own-device dismissals lose nothing new: the next activation clears every conversation's
  notifications.
- **The app-alive path** (`canari_push.mm`, `CanariHandleWakeBackgroundFrame`): a silent wake while
  the app runs in the background fetches, then dispatches as a full silent frame. Envelope wakes reuse
  it.
- **Not compiled by any pull-request job** - only a release's `ios.yml` builds the Swift and the
  ObjC++. Every iOS work package below depends on
  [the compile-only iOS job](../cicd.md#a-pull-request-compiles-the-ios-app-unsigned-compile-ios-app-2026-11-04) existing
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
whether the switch can stay on is `[PUSH_SEND] mode=wake` minus the wakes answered at least once
(MLS: `[PUSH_WAKE] served|gone`; envelopes: a `servedAt`), per
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
  proved that same `senderId`. **Owner, 2026-11-14: every notification name is composed by the
  device, and none rides a push** - a proven author is named by their nickname in the community
  (`conversation_nicknames.json`), else by `display_names.json`
  ([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)).

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
`groupId`, `callId`, `hasVideo`, `ringUntil` - pseudonymous ids, but a call graph.

**Owner, 2026-11-04 (N2): the ring stays as it is - immediate, ids only, no fetch-based ring.** The
alternative that was weighed (an opaque `ringId`, the call reported at once as a neutral "Canari call"
and updated after a fetch) is NOT built: a CallKit regression on a store build costs VoIP delivery for
the whole app, and a failed fetch would leave a ring that cannot be answered. **Only the cheap half
ships (WP-W6): `call_ring_end` drops `groupId`** and carries `type`, `callId`, `reason` - a ring is
ended by its `callId`, which is all both platforms need to find it. So what Google and Apple keep
learning about calls is the `call_ring` row of section 1, and the register says so.

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
- **The Graine seed mirror labels each entry with its writers since 2026-11-07**
  ([auth](../frontend/modules/auth.md#the-seed-mirror-labels-each-entry-with-its-writers-2026-11-07)).
  The wake reads it exactly as a full push does, and a seed a wake's frame yields is stamped by the
  same decrypt, so the label needs nothing from the wake.

### Who writes `push_context.json`, and when (2026-11-07)

Every background reader - `MlsContextLoader.readPushContext` (Android), the NSE and `canari_push.mm`
(iOS) - needs `userId`, `deviceId` and `baseUrl`; the device key is in the keystore, not the file.

| Event | Writer | What the file holds after it |
|---|---|---|
| Every sign-in, PIN **and biometric**, once `mls.bin` is saved | `store_push_context` (`TauriMlsService` init) | the whole session: `userId`, `deviceId`, `baseUrl`, `pushToken`, `locale`. A PIN sign-in also writes the key to the keystore; a biometric one passes `deviceKeyB64: null` and leaves the entry it read alone |
| A device-key change | `store_push_context` (`changeDeviceKeyImpl`) | the same, with the new key |
| A device id minted or restored | `store_device_identity` | patches `userId`, `deviceId` only |
| A language change | `set_push_context_locale` | patches `locale` only |
| A sign-out | `end_push_registration` (`keep_device_context_only`) | `userId`, `deviceId`, `locale` - **no `baseUrl`, so every reader finds no session** |
| An account deletion | `remove_user_push_files` | nothing |

**The defect this table closes (owner's Android report, `1.6.6`, production).** Until 2026-11-07 the
init skipped `store_push_context` whole when it had no key in hand - the biometric path - so the only
sign-in that rewrote the file was a PIN one. A sign-out strips the file (above, since #2302,
`v1.4.1`); a phone that signed out and came back by fingerprint kept the stripped file, and every
push since was the generic "Nouveau message de ..." banner: no decrypt, the worker enqueued for
nothing. The owner's log shows two sign-outs and only biometric sign-ins after them, and its last
background-decrypted message injected from the FCM cache sits BEFORE the first sign-out. iOS took
the same path with Face ID: the NSE requires `baseUrl` too.

**A refusal now says which.** The Android readers logged `push_context.json absent or invalid` for
two different defects; `PushContextVerdict` (`fr.emse.canari.push`, unit-tested in `android-tests`)
classifies at the read: `absent`, `unreadable (<exception class>)`, or `invalid: <fields> missing`,
with `(the shape a sign-out leaves - no sign-in rewrote it)` when only `baseUrl` is gone. The iOS
readers say the same words: `pushContextRefusal` in the NSE, `CanariPushContextRefusal` in
`canari_push.mm`, both read only on the failure path, and neither changes what the reader does.

**The write is fenced on the sign-out generation.** `TauriMlsService.storeSessionPushContext` is the
one JS call site of `store_push_context`. The write is chained on the `mls.bin` save and on a token,
so a sign-out can land between the request and the write. It would then put `baseUrl` and the bearer
back for the account that left, after `end_push_registration` stripped them. Only the FCM service
honours the signed-out mark: the workers, the boot receiver and the notification actions would act
for that account again. An account switch in the same window would pair A's ids with B's token.
So init captures `signOutGeneration()` (`auth.ts`) at ENTRY, and the write is dropped, with a line,
if the generation has moved by then. On the native side, `deviceKeyB64: null` is the ONLY "no key"
case: an empty or blank key is refused at ERROR (`session_key_of`, `push.rs`) rather than taken for a
biometric sign-in.

## 8. Rollout, and old clients

- **Two locks, ANDed, unchanged**: the estate's `platform_config.push_mode` and the token's
  capability. **The capability becomes a VERSION** (`push_token.wakeVersion` int: 0 none, 1 MLS frames
  - today's `wakeCapable = true` - , 2 envelopes), written on every register from
  `PUSH_WAKE_DECLARED[platform]`. An envelope wake goes only to `wakeVersion >= 2`; a step-1 build
  keeps receiving full salon and social pushes, never a wake it would drop. (A second boolean would do
  the same and leave a third the day the wake protocol changes again; a version does not.)
  **The migration is two steps, and only the second is destructive**: WP-W3 ADDS `wakeVersion`, and
  both are written on every register for as long as a reader of `wakeCapable` ships; the column is
  DROPPED later, in its own migration, which goes through
  the [held-migration lane](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01) (an
  approval line merged before the release that carries it).
  **As built (046): NO backfill**, against the first design. An `UPDATE` backfill is the author's to
  mark held (`infrastructure/lib/migration-hold.sh`), which blocks every release until an approval
  line lands - and it buys nothing: `push_mode` has never been `wake` on production, and a row left
  at 0 is sent the full push, the contract its binary registered under, until its next app start
  writes the real version. On an estate where the switch already reads `wake` (dev, once WP-W1 is
  taken), a step-1 device is sent full MLS pushes from the deploy until its app next starts: a
  privacy step back for that window only, never a lost notification. The server reads
  `wakeVersion` (MLS wake at `>= 1`, envelope wake at `>= 2`) **through `effectiveWakeVersion`, which
  answers 0 whenever `wakeCapable` is false**: until WP-W3c drops it, a row can be re-registered by a
  server that knows only `wakeCapable` (an old replica during a rotation, or a rollback before 046),
  which leaves the last `wakeVersion` stale beside a fresh `wakeCapable = false` - a downgraded binary
  would otherwise be woken. Removed with `wakeCapable`. A registration body says `wakeVersion`
  (an integer, capped at 2 - versions are cumulative, so a newer binary is woken for what this server
  can send) or the step-1 `wake: true` (= 1); an unreadable `wakeVersion` is stored 0 and accused.
  The clients still send `wake: true` - WP-W4 makes Android send `wakeVersion: 2`.
- **Order, as the owner set it on 2026-11-02**: Android first, on dev, then production; iOS declares
  only once its extension readings are taken. The iOS constant stays `false` until then.
- **Legacy rows** ([legacy-compatibility](../legacy-compatibility.md)): the `legacyTitle` /
  `legacyBody` shim and the reaction's `social` wire type stay for every full-mode device; a wake
  device never receives them. **The `full` path itself becomes a legacy row** the day both platforms
  declare version 2, and **the owner decided on 2026-11-04 (N3) to retire it** - raising
  `minClientVersion` - once the devices still on it are few, by the measure in section 8.1.
- **Web push**: none exists (the web client is notified over its WebSocket only); nothing to migrate.

### 8.1 When "few" is reached - the measure that retires the full path

Two readings, both on production, both per platform, and BOTH must hold:

1. **The tokens.** One `GROUP BY` on chat-delivery's `push_token`: `platform`, `wakeVersion < 2` vs
   `>= 2`, over the rows whose `updatedAt` falls in the last 30 days (every app start re-registers and
   rewrites the row, so that is the set of installs alive this month; an older row is an install nobody
   opens, which a floor raise costs nothing). **Few = under 2 % of those rows, or under 10 rows,
   whichever is larger, on each platform.**
2. **The sends.** The share of sends that still left in full: `[PUSH_SEND] ... mode=full`, plus the
   `[SOCIAL_PUSH] ... sent` lines to a `wakeVersion < 2` token (WP-W3 adds `mode=` to that line), over
   all sends - **under 2 % on each of 7 consecutive days**. The token count says who is left; the send
   count says whether those are the devices still receiving notifications.

Both readings are written, dated, into the [legacy-compatibility](../legacy-compatibility.md) row.
Then the pull request of WP-W7 raises `minClientVersion` to the first stable declaring version 2 on
both platforms and deletes the full builders, `push_mode` and the legacy-sentence shim.

## 9. Server cost

- **Per visible push, one extra HTTPS request per device** through nginx to chat-delivery, guarded by
  `PushSecretGuard` (an HMAC compare) and one indexed lookup by primary key; per envelope push, one
  row lock on the device's registration, one INSERT per device at send and one UPDATE of `servedAt`
  at fetch; the deletions are batched by the registration sweep.
- **Volume = push volume**, which the logs already count: `[PUSH_SEND]` lines (MLS) and
  `[SOCIAL_PUSH] ... sent` (everything through `sendPushToUser`) per day. **Owed before the switch
  moves for a version-2 device, read on production**: those two counts per day and per hour of peak,
  and the p95 salon fan-out (`[CHANNEL_PUSH] ... recipients=N`) - the size of the largest burst of
  envelope inserts one salon message causes. Not guessed here.
- **Bytes, not only rows** - one table holds a salon ciphertext once per DEVICE (Q2 revised), so a
  row count alone cannot size it. Owed with the counts above, on production:
  1. **the bytes of one envelope, per kind** - no line logs a full push's size on every send
     (`[PUSH_SIZE]` speaks only on a refusal or an inline group left out), so this is read from the
     table itself on dev once the switch reads `wake` there and a version-2 device receives:
     `SELECT payload->'data'->>'type' AS kind, count(*), percentile_cont(ARRAY[0.5, 0.95])
     WITHIN GROUP (ORDER BY pg_column_size(payload)), max(pg_column_size(payload)) FROM push_envelope
     GROUP BY 1` (a salon message carries its ciphertext, so it is the large kind);
  2. **the bytes one send stores** = reading 1's p95 and max x the production fan-out above (devices
     per recipient included) - the worst single transaction;
  3. **the steady state**, after a week of the same:
     `SELECT count(*), sum(pg_column_size(payload)), max(pg_column_size(payload)),
     pg_total_relation_size('push_envelope') FROM push_envelope`, and the same `sum` per device
     (`GROUP BY "userId", "deviceId"`, its p95 and max against the cap x the p95 payload).
  The cap bounds one device at 200 x the largest payload; reading 3 says how far below that the
  population sits.
- **Storage**: envelopes live until the app opens, the token goes or the cap evicts them; a salon
  ciphertext is stored once per recipient device. The steady state is the backlog of closed phones,
  bounded by the cap.
- **Throttle**: step 1's 600 fetches per minute per user per replica covers envelopes too; a salon
  burst that exceeds it on one device is a `throttled` stage, accused, and the next open shows
  everything.

## 10. Work packages, in order, each with its gate

| # | Work package | Gate (what must pass before it merges / turns on) |
| --- | --- | --- |
| WP-W0 | Step 1, built (#2915, #2918, #2932) | the backlog entry's readings 1-5 |
| WP-W1 | `push_mode = wake` on dev, Android | reading 1 (Mi 9T, three texts, backgrounded then killed) and reading 3 (airplane mode -> the honest notification + `[PUSH_WAKE] ... failed`) |
| WP-W2 | `push_mode = wake` on production (Android declares, iOS does not) | WP-W1 read; then reading 4 for a week: every unfetched wake explained by a typed stage; the register + privacy policy line for MLS frames (reading 5) in the same change |
| WP-W3 | **BUILT 2026-11-07, switch OFF** (see section 3.2 "as built"): `push_envelope` (one table - Q2 revised), `wakeVersion` ADDED (no backfill - section 8), `sendPushToUser` stores and wakes when `push_mode = wake` and `wakeVersion >= 2`, the fetch answers `{status: 'push', fields, presentation}`; the step-1 MLS answer gains `presentation` too | **Passed**: jest (`push-payload.spec.ts`: the fetched map the same key/value set as the full push for a salon, a social comment, a chat reaction, a salon read and a join ask, on both platforms, and `presentation` equal to the full push's `aps`; `messaging.push-envelope.spec.ts`: every branch of the send decision; `push.controller.wake.spec.ts`: register and fetch) and PostgreSQL (`046_push_envelope.integration.spec.ts`: the migration replayed twice; a lost response fetched again is `served` twice, never `gone`; each of the three deaths deletes exactly its rows; the cap evicts served first, then silent, and WARNs only for an unserved banner, and takes a new silent envelope at once on a full device; same-salon `channel_read` collapses; `foreign` for another registration; a registration deleted under a store costs that device alone, and two concurrent stores keep one read envelope per salon and never pass the cap, both proven with a second session holding the row lock; store, serve and `buildEnvelopeAnswer` give the same key/value set as `buildInternalAndroidHalf` and the APNs custom keys through jsonb). The orphan-body gate fell with the body table. **Owed before the switch moves for a version-2 device**: the production volume counts of section 9, written here |
| WP-W3b | Server: `sendFcmWelcomeRequestPending` stores its map in an envelope and sends a silent wake to `wakeVersion >= 2` tokens instead of calling `getMessaging()` itself | jest: its tokens at `wakeVersion >= 2` receive `type=wake`, `envelopeId`, `silent=true` and nothing else, the fetched map equals today's four fields; on the Mi 9T, a new device's admission still wakes a closed member's phone (the existing welcome-request reading) |
| WP-W3c | The held migration that DROPS `push_token.wakeCapable` | no reader of `wakeCapable` left in any shipped server; the approval line merged by the owner or the lead under the delegation, before the release carrying it |
| WP-W4 | Android: envelope wakes (`envelopeId` -> fetch -> `dispatchPush`), the notification tag = `envelopeId` so a repeat answer redraws and never adds, the account bound at arrival and checked at dispatch, `PUSH_WAKE_DECLARED.android = 2` | `:app:compileArmDebugKotlin`; JVM tests (`WakeAnswerTest` for `push`, a repeated answer for one `envelopeId` drawing one notification, `WakeOrderTest` for an envelope ticket between a Welcome and its salon, a switch between arrival and dispatch); vitest `pushWakeCompiled.test.ts` extended; then on the Mi 9T: a salon text, a comment, a chat reaction, each with content; the blind-banner `not-inlined` reason reads zero on wake |
| WP-W5 | iOS: envelope wakes in the extension and in `canari_push.mm`, applying the answer's `presentation` (thread, sound, interruption level), the notification identifier = `envelopeId`, the account check, the first-unlock cause evidence, `PUSH_WAKE_DECLARED.ios = 2` | the compile-only iOS job ([p2](../cicd.md#a-pull-request-compiles-the-ios-app-unsigned-compile-ios-app-2026-11-04)) green; iPhone 12: reading 2 of the backlog entry for DMs, then salons and social, `[NSE_OUTCOME] kind=wake outcome=decrypted`, `peakMB` read for the largest salon; two reactions to one post and two salon messages stack under ONE thread each with their own sounds (the grouping a full push gives today) |
| WP-W6 | Calls: `call_ring_end` drops `groupId` (N2: the ring itself is unchanged) | jest: the ring-end payload's keys are exactly `type`, `callId`, `reason`; the Android and iOS ring-end handlers find the ring by `callId` alone (a test that would fail if either still read `groupId`); one ring hung up by the caller, read on both phones locked |
| WP-W7 | Retire the `full` path (N3): raise `minClientVersion` to the first stable declaring version 2 on both platforms; the register and the privacy policy say "a wake-up and an opaque id" for every push but a ring | the two readings of section 8.1 under their thresholds, written into the `legacy-compatibility.md` row; then the full builders, `push_mode` and the legacy-sentence shim deleted in one pull request |

## 11. Open questions

### Reversible - the recommended option is taken unless the owner says otherwise

| # | Question | Recommended |
| --- | --- | --- |
| Q1 | How a non-MLS push gets something to fetch | the envelope in chat-delivery (3.2 A), one implementation for every kind |
| Q2 | One envelope per device holding the whole map, or a shared body + per-device envelopes | **taken when built (2026-11-07): one envelope per device holding the whole map.** The shared body was recommended so a salon ciphertext is stored once per message, but a send is one `sendPushToUser` call for ONE account, so it could only be shared by that account's devices; section 3.2 has the reasoning |
| Q3 | How an unfetched envelope dies, with no clock | token deleted, device registers (an app start), per-device cap of 200 evicting served, then silent, then the oldest visible envelopes; serving only marks `servedAt` and a repeat fetch is answered the same map |
| Q4 | The capability: a second boolean or a version | `push_token.wakeVersion` int, added (046, **not backfilled** - section 8); the old column dropped later through the held-migration lane (WP-W3c) |
| Q5 | Should a fetched salon answer carry the author's display name | yes, keyed by `senderId`, drawn ONLY when the open proved that author; it removes the `no-names` cause of "Quelqu'un" without trusting the server's claim of authorship. Taken only if the parallel investigation finds `no-names` among the measured causes |
| Q6 | Silent wakes at FCM `normal` priority instead of `high` (deprioritisation of high-priority pushes that draw nothing) | keep `high` and measure: `gone` and silent wake counts per day in reading 4; change only on a measured deprioritisation |
| Q7 | What the production flip of WP-W2 waits for | every unfetched wake explained by a typed stage for a week, and the "could not be loaded" notification on under 1 % of visible wakes |

### Not reversible - decided by the owner, 2026-11-04

| # | Question | Owner's decision |
| --- | --- | --- |
| N1 | Ask Apple for the notification-filtering entitlement, so a `gone` wake draws nothing on iOS? | **No.** iOS keeps drawing an honest alert for every wake: the "could not be loaded" sentence for a failed fetch, the passive "already received" line for a `gone` answer (section 4.2) |
| N2 | Calls through a fetch (an opaque `ringId` ring)? | **No.** Only the cheap half: `call_ring_end` drops `groupId` (WP-W6); the ring stays immediate, ids only (section 6) |
| N3 | Retire the full path (WP-W7, raise `minClientVersion`)? | **Yes**, once the devices still on it are few - the measure and its thresholds are in section 8.1 |

Android beyond FCM (UnifiedPush with a self-hosted distributor) stays out of this design: it is an
install on the shared host, so the host owner's written agreement comes first (backlog entry).
