# Legacy compatibility - the shims still standing, and the date each one may go

Every entry here is a branch that exists ONLY to keep working against something older than the
current protocol. Each one is dead weight the day its condition is met, and each one is a place where
a future reader has to reason about two protocols at once.

**Why this file exists rather than a comment per site.** A compatibility shim is invisible once it
works: nothing fails, nothing warns, and the condition that would retire it is never re-checked. So
the condition is written down HERE, and the removal becomes a diary entry somebody acts on rather
than an archaeology exercise. Every shim below also carries a comment at its site pointing back here.

**Nothing below is WORK.** Each entry is a date, and the code change behind it is minutes. What is
being waited on is the world, not a decision - do not "do" these early, and do not re-argue them.

---

## What the 2026-08-17 gate actually retired, and what it did not

`minClientVersion` went to **0.14.0** on 2026-08-17. The gate is hard - `ensurePlatformAllowsUnlock`
blocks the MLS unlock outright, so a client below it cannot put a group frame on the wire at all.

It was assumed at the time that this retired most of this page. **Measured, it retired exactly one
entry**, and the distinction is worth keeping because it is the one this page was getting wrong:

- **A shim that humours a LIVE PEER is retired by the gate.** Only one was:
  `history_bundle` with no `since`, deleted 2026-08-17.
- **A shim that decodes DATA AT REST is not**, whatever the fleet is running. The bytes were written
  before the change and they are still there; the gate says nothing about them. Four entries below.
- **A shim that protects the SERVER's response shape is not either**, because the replacement has
  never shipped. One entry below, and it has no date for that reason.

**And a date is only worth what the mechanism under it is worth.** These four were dated on the claim
that `history:{groupId}` expires after `RETENTION_WINDOW_MS`. It did not: the key carried a TTL
*refreshed on every write*, and `HISTORY_STREAM_MAXLEN` bounds the entry COUNT, so a group under the
cap kept every row it had ever held, for ever. Measured on production 2026-08-17: **four of five
streams still carried rows from before 2026-08-15**, at 1 to 11 entries each, in streams nowhere near
the 8 000 cap. The write path now trims by `XTRIM ... MINID` at `RETENTION_WINDOW_MS`
(`messaging.service.ts`), which is what makes the dates below mean something.

**One deliberate break, recorded here so it is not read as an oversight.** `DELETE
/api/channels/workspaces/:id` requires a `confirmationName` since 2026-08-18, and a client that does
not send it is refused. No shim was written on purpose: that route stopped archiving and now destroys
a community outright, while older clients still ask "are you sure?" in the words of the reversible
action. Accepting their call would let them destroy something behind a warning that no longer
describes it, so the missing argument IS the protection - see
[social-service](services/social-service.md#deleting-a-community). It retires itself when no client
below 0.15.0 remains; there is nothing to delete when it does.

**And one deliberate NON-break, recorded for the same reason.** `DELETE /api/channels/:channelId`
made the identical archive -> destroy move on 2026-08-20 and took **no** new argument. The rule the
entry above establishes is not "a delete that becomes real needs a token" - it is *check what the
deployed clients are promising before changing what the server means*. Here they were already
promising it: `chat_delete_channel_confirm` has read "Supprimer definitivement le canal #x ?" since
`5babb466` (2026-06-16), the first version of the string that shipped. A gate would have broken
working clients to protect them from a warning that was accurate all along - see
[social-service](services/social-service.md#deleting-a-channel-took-no-new-argument-deliberately-2026-08-20).

---

## Removable at floor 1.2.7

**Audited 2026-10-15, against `main` at `9f7ccfef8`**, when the user reported `1.2.7` served by BOTH
stores (Play `1.2.8`, the App Store `1.2.7`), so that `minClientVersion` could rise from `1.0.3` to
`1.2.7`. A removal marked "with the floor" REFUSES what an older build sends, so it may only deploy
once `minClientVersion` reads `1.2.7` or more **on the estate it deploys to**: `platform_config` is
PER ESTATE (production and `dev.canari-emse.fr` each hold their own row), so the floor is raised in
`/admin/platform` on BOTH, dev included, or a pre-release carrying a refusal breaks a dev tester on an
older build. "First release" is the first stable tag containing the replacement (`git tag --contains`);
a shim is removable by the floor only when that release is `<= 1.2.7`. A floor never retires DATA AT
REST: those rows need a count, then a migration.

| Shim (entry below) | Condition | Met at floor 1.2.7? | Data at rest | Removal size | Disposition |
| --- | --- | --- | --- | --- | --- |
| `paymentMethod: 'stripe'` STORED | rows written before 2026-10-08 | no - data | `purchase_records` and `submissions` | type + 3 client arms, after a migration | owed: count + migration (user) |
| Salon push held for a sender with no `seedFrame` | floor >= first release sending `seedFrame` | version YES (`v0.18.28`); proof NO | none | server refusal + Kotlin hold registry, native | NOT removed: nothing has measured that EVERY admitted send carries the frame (the server never stores it), so a required field could refuse an honest send. Owed: a log of frame-less non-silent sends, read for a week, then a native PR |
| Server `legacyTitle`/`legacyBody` on social/form pushes | clients reading `contentKey` (2026-08-19) | version YES (`v0.14.1`) | none | ~-50 lines server + Kotlin + Swift arms | NOT removed: dropping them leaves an iOS alert EMPTY whenever the NSE does not run, a visible behaviour change, not a removal. Needs a decision and an iPhone reading |
| Reaction push keeps wire type `social` + a generic `body` (`notify-reaction`; had no entry here) | clients knowing `reaction: 'true'` (2026-08-15) | version YES (`v0.14.0`) | none | server + Kotlin dispatch | NOT removed, same iOS-alert question as the row above |
| Post `images` field (in and out, `posts.service.ts`; had no entry here) | clients sending `media` | not established | `posts.images` is the column itself | DTO + normaliser | NOT removed: the client switch is undated; find it before judging |
| Pre-MLS send path + `queued_message.content` | log silence (`LEGACY_CONTENT_PATH`/`_ROW`), dated 2026-11-19 | not a version question | the column | `else` arm + migration | owed: log read + count + migration |
| Graine v1 reader | 0 unsigned rows | NO | 373 rows (2026-10-14) | - | revisit 2027-10-13 |
| `read_receipt` (both entries), `remove_reaction`, `pin`/`unpin` undated, no `sender_device_id`, no `message_id` | live peers (met) AND archive retention | live half YES, archive NO | Redis history streams | per entry | dates 2026-11-13 to 2026-12-15 stand |
| Refresh cookie on `tauri://localhost` | floor AND a desktop measurement | floor YES, measurement NO | none | - | unchanged |
| MiConnect `formation`/`promo` claims | WP9 | NO (not a version) | Authentik attributes | - | unchanged |
| `GET /history` bare array | replacement shipped, then floored | NO (never shipped) | none | - | unchanged |
| `LEGACY_PERMISSION_MAPPING` (`channel-role.entity.ts`; no entry here) | no `channel_roles` row holds an old key | not a version question | `channel_roles.permissions` | 1 map + 1 hook | owed: count |
| Form `dependsOn`/`dependsValue` (`forms/visibility.ts`; no entry here) | no stored form uses the pair | not a version question | `forms.items` | reader branch | owed: count |
| State blob v1 header WRITER (`frame_v1`, CORRUPT-1/2) | floor >= the reader (`v0.18.18`) | YES | it CHANGES device data at rest | 1 line + `serverProse.test.ts` | FLIPPED in its own MLS PR (PK1, 2026-10-17, unshipped until a tag carries it); the LEGACY reader stays for blobs not yet rewritten ([backlog](backlog.md)) |
| `MLS_STATE_SEAL_V2_WRITER_ENABLED` | a stable with the reader served the web AND floor >= it | YES (`v1.2.7`) | it CHANGES device data at rest | 1 line, then the encrypt worker | NOT done here, same reason |
| The `1.2.1` key-group epoch floor (backlog owed line) | floor >= `1.2.1` | YES | - | - | closes when the user sets 1.2.7 |
| Group removal hold (#1878) | floor >= the release carrying it | NO (`1.2.9`) | - | - | waits |
| `canari_post_feed_kind` drop (`posts/retiredFeedKind.ts`, run by the feed's `load`) | every device that ran a `1.2.9-alpha.2`/`.3` has opened the feed once on a later build | not a version question (alphas only) | one device-global `localStorage` key | 1 module + 1 call | remove with the first stable after `1.2.9` ([reels](frontend/modules/reels.md#the-canareels-entry---an-icon-beside-the-tabs-that-opens-the-viewer-user-2026-10-16)) |
| `klipy_cid` drop (`utils/chat/retiredKlipyCustomerId.ts`, run at the root layout's mount) | every install older than 2026-10-16 has started once on a later build - a CLIENT FLOOR, since an install that never updates keeps the key and also keeps sending it | `minClientVersion` past the release carrying it | one device-global `localStorage` key, the per-install id older builds sent to KLIPY | 1 module + 1 call | remove with the first stable after the floor passes that release ([chat](frontend/modules/chat.md#the-gif-search-goes-through-canari-2026-10-16)) |

**Owed to the user, read-only, before any migration above** (production Postgres, as
[databases](infrastructure/databases.md#reaching-it-from-a-workstation) describes):

```sql
SELECT count(*) FROM purchase_records WHERE "paymentMethod" = 'stripe';
SELECT count(*) FROM submissions WHERE "paymentMethod" = 'stripe';
SELECT count(*) FROM queued_message WHERE content IS NOT NULL;
SELECT count(*) FROM channel_roles WHERE permissions ~ '(MANAGE_WORKSPACE|MANAGE_CHANNELS|MANAGE_ROLES|MODERATE_MESSAGES|INVITE_USERS|SEND_MESSAGES)';
SELECT count(*) FROM forms WHERE items::text LIKE '%"dependsOn": "%';
SELECT count(*) FROM channel_messages WHERE "signature" IS NULL AND "senderSessionId" IS NOT NULL;
```

---

## The diary

### No date yet - a notification TYPE the client does not know, from any new server type

**Site:** `NotificationRow.svelte` and `notificationHref` in `frontend/src/lib/posts/notificationTarget.ts`.
**The defect in released clients (v1.0.3 up to main before the release carrying PR #1911):** an unknown
`type` fell into the row's final `{:else}`, the COMMENT branch ("<actor> a commente : <title>", comment
glyph), and `notificationHref` answered `/posts/<id>`, a dead link when the id is not a post. Native
pushes are not affected: Android and iOS (NSE and `canari_push.mm`) keep the server's own wording for
an unknown `contentKey` and log it. An unknown deep-link HOST of our scheme used to open the app and go nowhere; it
now lands on `/notifications`. **But a push for a new type does not get there by itself:** the server
(`socialDeepLink`, `apps/social-service/src/push/push-target.ts`) and Android
(`CanariFirebaseMessagingService.kt`) map ANY `postId` to `fr.emse.canari://post/<id>`, so a new type whose
id is not a post keeps a DEAD tap on every client.
**Consequence for the ones already shipped:** `profile_correction_*`, `coorganise_proposed` and
`repost_proposed` (and the agenda's types before their own rows) show the comment sentence on a client
older than the release carrying their rows.
**THE MINIMUM CLIENT VERSION MUST COVER THIS FIX BEFORE ANY NEW NOTIFICATION TYPE SHIPS** - the release
carrying PR #1911, both stores serving it, then `minClientVersion` raised to it. A new type shipped
earlier reaches the floor clients as a wrong sentence and a dead link, which no server change can undo.
**Checklist - a NEW notification type** (no other checklist existed; this is it):
1. The floor above covers PR #1911 first.
2. The server sends an EXPLICIT `deepLink` (or a dedicated host) for it in `socialDeepLink`; never rely on the `postId` -> `post/<id>` default when the id is not a post.
3. Add the type to `KNOWN_NOTIFICATION_TYPES` and the `notificationHref` switch (`notificationTarget.ts`), and give `NotificationRow` its glyph, colour and Paraglide sentence; the tests walk every known type through both.
4. Native tables (`composeServerNotification`, NSE, `canari_push.mm`) get its `contentKey`.
**Removal condition:** none; this is a floor requirement, not a shim.

### No date yet - a stored `paymentMethod` of `stripe`, written before the Stripe removal

**Site:** `PurchasePaymentMethod` in `apps/social-service/src/users/entities/purchase-record.entity.ts`,
`Submission.paymentMethod` in `apps/social-service/src/forms/entities/submission.entity.ts`, and the
`'stripe'` arms of the client's `paymentMethod` types and labels (`EditAchatsTab`,
`EditDelegationTab`, `account/purchases`).
**Shim:** purchase rows AND form submissions written before 2026-10-08 hold `stripe`, read as
`online`. Nothing writes `stripe` any more, and since floor 1.2.7 nothing may SEND it either: the
form input and the `fr.emse.canari://stripe` return host are gone ([stripe-archive](stripe-archive.md)).
**One known cost of the host's removal:** a checkout STARTED on a build from 1.2.0 to 1.2.3 (Lydia
already, `stripe` host still) and finished after the phone updated returns to a host the new build
no longer registers - the payment itself is recorded server-side, only the in-app landing is lost.
The server's refusal of a `stripe` callback URL is logged (`[CHECKOUT] callback URL REFUSED`).
**Removal condition:** data at rest, so a data migration of `purchase_records` AND `submissions`
(`stripe` -> `online`), counted first, and no version: then the type and the client arms go.

### No date yet - MiConnect's `formation` and `promo` claims, derived from the profile

**Site:** the scope mappings `miconnect-claim-formation` and `miconnect-claim-promo` in
`infrastructure/authentik/blueprints/10-mappings.yaml`; and the old attribute keys `formation`,
`promo` and `school_status`, still written by enrolment and left in place by the migration.
**Shim:** since WP1 (profile reform) the profile holds a LIST of cursus and posts
([profiles-and-access](profiles-and-access.md)). Every application still reads one `formation` and
one `promo`, so both claims are the FIRST cursus - a person with two cursus shows only the first.
**Removal condition:** WP9 - every application reads `cursus` / `posts` / `campus` and no longer
requests the `formation` or `promo` scope. Measured then on authentik's access log: no
`/authorize` naming either scope for a week.

### No date yet - the Graine v1 reader: a salon row with no signature, under a session with no endorsement

**Site:** `openChannelMessage` in `frontend/src/lib/utils/graine/channelSeal.ts`, the `openWithGraine`
branch taken when the session carries no `v2` block; its native twin is `open_graine_message` in
`src-tauri/src/mobile/graine.rs`. `storeIncomingSeed` REFUSES a new v1 seed since 2026-10-11
(step one below, [channel-encryption 21.7](protocols/channel-encryption.md#217-an-arriving-v1-seed-is-refused-wp-g2-5b---the-floor-reached-the-writer-2026-10-11)); a held one still opens.
**Shim:** Graine v2 (channel-encryption section 21) binds a row to its salon, author and index and
signs it. A v1 row proves none of that, and a v1 seed names no minter. v1 is kept because every row
written before the v2 writer is v1, and they stay readable for as long as they are kept.
The v1 WRITER is already gone (G2-5): `sealWithGraine` lives only in the test fixture
`crypto/graine.testSeal.ts`, so this entry is a reader alone.
**Removal condition, in two steps (user, 2026-09-28):**
- DONE (floor `1.0.3`, 2026-10-11): a v1 seed that ARRIVES is refused, since a modified client
  could otherwise keep minting v1 sessions to forge an author. An unsigned row under a session not
  held is `GraineV1SessionNotHeldError` and asks nobody;
- the v1 READER goes when no v1 row is left:
  `SELECT count(*) FROM channel_messages WHERE "signature" IS NULL AND "senderSessionId" IS NOT NULL`
  on production answers 0. Rows age out of the 365-day window, so that is at most a year after the
  writer ships. A count, not a date: a salon nobody prunes keeps its rows. **Since the server refuses
  an unsigned row (2026-10-13, see the section below) that count can only fall**, so a 0 stays 0.
  **Measured 2026-10-14 on production: 373 rows in 15 salons, none pinned**, oldest 2026-09-02,
  newest 2026-10-09. A pinned row escapes the retention purge, so pinning one of them would hold the
  count above 0 after the date: then name the salon, as the section below says.
  On the same day, `channel_messages."signature"` becomes `NOT NULL` (a migration), and the DTO's
  `signature?` and the `?? null` in `ChannelService.sendMessage` go with it.

### No date yet - the salon push HELD for its seed, for a sender that attaches no seed frame

**Site:** `CanariFirebaseMessagingService.handleChannelMessage`, the branch after `openSeedFrame`
answers null: `PENDING_CHANNEL_FRAMES`, `PENDING_CHANNEL_LOCK`, the `genericStamp == 0` claim in
`drainPendingChannelFrames` and `arrivedMeanwhile`. On the server, `assertSeedFrame` accepting a
message with neither field.
**Shim:** since [channel-encryption §19](protocols/channel-encryption.md) every message carries the
MLS frame that distributed its session's seed, and the phone opens it when the mirror misses. A
sender older than that attaches nothing, so its first message still races its seed push, and the
generic banner held and redrawn (§14) is what covers it. Since §19 both pushes run on the one MLS
lane, so the lock and the in-flight claim guard a window that can no longer open.
**Removal condition:** `minClientVersion` at or above the first release that sends `seedFrame`. Then
`seedFrame` / `seedGroupId` become REQUIRED on a non-silent message (a typed refusal, like
`CHANNEL_SESSION_REQUIRED`), and the hold, the registry, its lock and the drain go with it - a
mirror miss with no frame becomes a line that accuses, not a path.
**Cost of keeping it:** eight map entries at most and a redraw nobody on a current build reaches.
The hazard is the redraw itself: it is the defect §19 removes, alive for exactly this population.

### No date yet - the `read_receipt` system event, accepted from clients that predate the watermark

**Site:** `systemMessageHandler.ts`, the `event === 'read_watermark' || event === 'read_receipt'`
branch - the second name, and the `watermarkAfterReading` conversion behind it.
**Shim:** before `0db47a87` (2026-08-12) read state travelled as a LIST OF MESSAGE IDS. The app has
sent an instant ever since, and as of 2026-08-31 so does the native notification shade, which was
the last emitter of the old shape anywhere in this repo. Incoming `read_receipt` frames are still
translated: the ids we hold give the instant directly, and ids we do not hold say nothing we could
have acted on anyway.
**Why it is not just "old clients":** a `read_receipt` is a MESSAGE, so it can arrive from any peer
running any build, and history replay can hand one back long after every device has updated. The
population is not "installs older than X", it is "frames older than X", which no version gate
retires.
**Removal condition:** `minClientVersion` at or above the first release carrying the native
watermark AND no `read_receipt` observed in a history bundle for a full retention window (90 days),
because a stored frame outlives the client that wrote it. Until someone measures the second half
this entry has no date - a date here would be a guess about what is sitting in the frame table.
**Cost of keeping it:** one string comparison and one `watermarkAfterReading` call on a branch that
already runs. It is cheap; what it must not become is the reason nobody notices that the two names
mean subtly different things - ids are a SET and an instant is an ORDER, and the translation is
lossy in exactly one direction.

### No date yet - the refresh COOKIE accepted from a `tauri://localhost` client

**Site:** `presentedRefreshToken()` in `apps/core-service/src/auth/auth.controller.ts` - the last
`return cookie` after the header has been found absent.
**Shim:** a client on the custom-scheme origin is expected to carry its refresh credential in
`X-Canari-Refresh` (`refresh-transport.ts`), because WKWebView drops the third-party cookie -
measured on prod 2026-08-27, `cookies=[]` on 120 consecutive refreshes from one iPhone. When that
header is absent the cookie is still read.
**Why it is not just "old iOS clients":** `tauri://localhost` is ALSO the macOS and Linux desktop
origin, and nothing has ever measured whether their engines keep the cookie. (No Linux desktop
artifact SHIPS since 2026-09-03, but the origin is a property of the engine and returns with anyone
who builds that target locally, so the shim's population is unchanged in kind.) If they do, refusing it
here would log every desktop install out on the deploy that introduced the header - so the shim is
covering an unknown population, not only an old one.
**Removal condition, and it has two halves:** (1) `minClientVersion` is at or above the first release
carrying `nativeRefreshToken.ts`, so no client on that origin predates the header; AND (2) desktop
persistence has been MEASURED on macOS and Linux - if the cookie works there, that platform keeps it
and the removal is instead a narrowing of `BODY_TRANSPORT_ORIGINS`, not a deletion. Until (2) exists
this entry deliberately has no date: a date would be a guess about a platform nobody has run.
**Cost of keeping it:** one header read and one cookie read per refresh. The hazard is not cost, it
is that a client sending neither looks identical to one sending a stale cookie, which is why the
refusal already logs the cookie names it received.

### 2026-11-19 - the pre-MLS send path, and the `content` column it is the only writer of

**Site:** the `else` arm of `MessagingService.sendMessage`
([`messaging.service.ts`](../../apps/chat-delivery-service/src/services/messaging.service.ts)), taken
when a caller posts no `proto`; `QueuedMessage.content`
([`queued-message.entity.ts`](../../apps/chat-delivery-service/src/entities/queued-message.entity.ts));
and the read side, `queued.proto ?? queued.content ?? ''` in `push.controller.ts`.
**Shim:** every client since MLS sends `proto`, a base64 MLS ciphertext. This branch takes
`body.content` with a `type` tag and fans out over `dm_group_members` instead of the device
membership table. Nothing else writes the column.
**What the evidence actually says:** on 2026-08-19 `queued_message` held 817 rows back to
2026-07-28, `proto` non-null on **817**, `content` non-null on **0**. That is strong and it is not a
census - **the queue records only what was UNDELIVERED**, so a legacy message delivered instantly
leaves no row, and it is only evidence for the question it was written to answer. The service log
would settle it, but its window is one container lifetime and a deploy restarts the container: on
2026-08-19 it held six `[SEND]` lines over three hours.
**Why a date rather than a deletion now:** the fleet is mixed by construction - A1's APK carries its
own bundle and a deploy never reaches it - and deleting a send path that one old client still takes
turns a working install into one that cannot send, silently. Three months is one campaign plus the
margin for a phone nobody has updated.
**On removal:** delete the `else` arm, the `content` column (migration), the `?? queued.content`
arm, and this entry. Both sites now log - `LEGACY_CONTENT_PATH` on write and `LEGACY_CONTENT_ROW` on
read, both at warn - so the date is checked by reading whether either ever fired, not by arguing
about it. **If either has fired, the caller is found and fixed before the branch goes**, because
reaching a fallback means the primary path failed.
**Cost of keeping it:** a nullable column on the largest MLS table, and a read-side `??` that made
the column look load-bearing to anyone auditing it - which is how it survived unnoticed until the
storage panel raised the question.

### 2027-02-19 - a server-composed `title` / `body` on social and form pushes

**Site:** `PushContent.legacyTitle` / `legacyBody` in
[`apps/social-service/src/push/push-content.ts`](../../apps/social-service/src/push/push-content.ts),
passed through by `PushService.notifyContent`.
**Shim:** since 2026-08-19 those pushes carry `contentKey` + `actorName` + `contentArg`, and the
device writes the sentence from its own two-language table. Clients built before that read `title`
and `body` and know nothing of the key, so both are still sent, in the wording they had - French for
the post notifications, English for the form reminders.
**Why a shim rather than a clean break:** dropping the two fields does not degrade an old client, it
BLANKS it - `data["body"] ?: ""` on Android, `content.body` left as the empty alert on iOS. Every
phone installed today would show a notification with no text, and nothing would say why.
**Why the date is six months out, not three:** an Android or iOS user updates when their store
decides to. The other entries here are protocol shims between a client and a server that deploy
together; this one waits on app installs.
**On removal:** delete the two fields from `PushContent` and its six builders, have `notifyContent`
call `notify` with empty title and body exactly as the MESSAGE push path already does, and delete
the `?: data["title"]` arms in `CanariFirebaseMessagingService.composeServerNotification`'s caller,
`NotificationService.applyServerContent` and `CanariComposeServerNotification`. All three already
log when they take that arm, so the traffic is measurable before the date rather than guessed at.
**Cost of keeping it:** two short strings per push, and a real hazard the log answers - while both
halves are sent, a key missing from a native table is invisible, because the phone silently shows
the server's wording and it looks deliberate. `nativeStrings.test.ts` is what closes that.

### 2026-11-13 - history rows with no `sender_device_id`

**Site:** `historyTypes.ts` (`HistoryStreamRow.sender_device_id?`) and the `kind === 'own-message'`
arm of the replay's catch in `frontend/src/lib/utils/chat/history.ts`.
**Shim:** the replay skips a row whose `sender_device_id` is this device before offering it to MLS. A
row written before 2026-08-15 has no such field, so it still reaches MLS and is still recognised by
its refusal - `CannotDecryptOwnMessage`, classified at the throw in `mls-core`. That arm is the shim;
the skip is the mechanism.
**Why the field and not `sender_id`:** the archive is ONE stream per group and must hold this
device's own frames, because every other member reads it. The user cannot discriminate - the same
account's other device wrote frames that are both decryptable and wanted. Only the device can.
**On removal:** delete the `ownFramesSkipped++` line in the catch, keep the classification itself,
and make `sender_device_id` non-optional in `HistoryStreamRow`.
**Cost of keeping it:** none in traffic. The old rows are still handed to MLS to be refused, which is
what happened before the field existed; the fix only stopped that from being the design.

### 2026-11-15 - `remove_reaction` as a system event

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the
`remove_reaction` branches.
**Shim:** both branches translate the old frame into `applyReaction(..., removed = true)`, dated with
the entry's own delivery time because that frame shape carries no timestamp of its own.
**Replacement:** taking a reaction back is the SAME `ReactionMsg` that placed it, with `removed` set -
so both legs of one operation have one shape and both carry the `at` the merge orders on.
**On removal:** delete both branches, and drop `remove_reaction` from the silent-event list in
`proto_fields.rs`.
**Cost of keeping it:** a removal replayed from an old stream entry is ordered by its delivery time
rather than by the sender's clock. Only distinguishable if a placement and its removal were sent
within the same delivery, which cannot happen - the outbox serialises them.

### 2026-11-15 - `pin`/`unpin` with no `at`, and a pinned set stored as a bare array

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `pin`/`unpin`
branches; `mergePinEntries` and `parseStored` in `pinStore.svelte.ts`.
**Shim:** three readings of the same missing clock. An undated frame arriving LIVE is dated on
receipt - later than anything held, the right answer for a frame arriving now and the only one
available. An undated frame REPLAYED is dated by its position in the shared log
(`parseServerTimestampMs`), the best clock a replay has. A `pins` array of bare id strings - the shape
shipped for one commit on 2026-08-16, and the shape of every `canari_pins_*` entry written before it -
is read at `at: 0`, so any dated statement about the same message beats it.
**Replacement:** the frame carries `at` on both legs, exactly as a reaction's two legs do, and the
register is a last-write-wins entry per message with dated tombstones for the unpins.
**On removal:** delete the three `Number(data.at) ||` fallbacks, the `typeof raw === 'string'` arm of
`mergePinEntries`, and the `Array.isArray(parsed)` arm of `parseStored`.
**This one has a SECOND store behind it, and the date does not cover it.** `canari_pins_*` is
`localStorage` on each device, which nothing on the server can reach and no retention window bounds.
The `Array.isArray` arm may only go once every device has rewritten its own entry - which happens on
the first pin change in each conversation - so on the date, delete the two frame-shape fallbacks and
re-read that arm as its own question.
**Cost of keeping it:** an undated pin loses every tie against a dated one, so a device that pinned on
an old client and a device that unpinned on a new one converge on unpinned even if the pin came
second. The user can always pin again; the reverse - a resurrected pin nobody can explain - is the
outcome the dating exists to prevent.

### 2026-11-15 - `read_receipt` naming message ids

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `read_receipt`
branches; and the per-message `readBy` / `readAt` still sitting inside encrypted rows written before
the change.
**Shim:** a receipt is translated into a watermark - the latest instant among the named messages THIS
DEVICE HOLDS. An id it does not hold contributes nothing, which is the only honest reading: the frame
names messages, and without one there is no instant to compare against.
**Replacement:** `read_watermark`, one monotone instant per participant merged as `max`. See
[history-reconciliation](protocols/history-reconciliation.md#read-state-becomes-a-watermark).
**On removal:** delete both branches and the `event === 'read_receipt'` half of their conditions.
Nothing else has to move - the stored `readBy`/`readAt` are already ignored on read, and the watermark
column is additive (SQLite v6).
**Cost of keeping it:** a receipt for messages this device never had reads as no read state at all,
where the sender did read something. It corrects itself on the next watermark that peer sends.

---

### 2026-12-15 - a visible system notice with no `message_id`

**Site:** `systemMessageHandler.ts` (the `messageId?` field of `SystemEventContext`, undefined for an
old frame) and `historySystemEvents.ts` (`parsed.messageId || undefined`). Both then let
`addMessageToChat` mint a `crypto.randomUUID()`, which is the pre-2026-09-16 behaviour.
**Shim:** none is written as a branch - the shim IS the undefined, and what it buys is that an old
frame still draws its notice instead of being dropped.
**Replacement:** `mkVisibleSystem` (`proto/codec.ts`) mints the id at the SENDER, once, so the live
path, the archive replay and a peer's `history_bundle` all write one row for one event. See
[chat](frontend/modules/chat.md#a-visible-system-notice-needs-an-identity-the-sender-minted).
**Two conditions, not one, and the date covers only the second.** A LIVE PEER below the version that
ships this keeps sending id-less frames, and that half is retired by `minClientVersion`, not by a
date. The ARCHIVE holds id-less rows written before it, and those are trimmed by `XTRIM ... MINID` at
`RETENTION_WINDOW_MS` (90 days) - hence 2026-12-15.
**On removal:** make `messageId` required on `SystemEventContext`, drop the `|| undefined` in the
replay, and delete this entry.
**Cost of keeping it:** exactly the defect this replaced, confined to old frames - a notice from
before the change still duplicates once per replay and once per bundle. **Nothing repairs the rows
already on disk**; see [backlog](backlog.md).


---

## Nothing to remove - a calendar subscription saved before D40 now gets a 400 (2026-10-05)

**This is a BREAK, not a shim, and there is no code to retire later.** `GET
/api/associations/calendar/feed.ics` and the anonymous `calendar/feed` now REFUSE a read that names no
campus, formation, `associationId` or `eventId`: a 400 with code `AGENDA_SELECTION_REQUIRED`
(`assertAgendaSelected`, `associations/directory-query.ts`). The user chose this on 2026-10-05,
knowing it (user decision, D40: no per-user URL, no fallback to "everything").

- **Who is affected:** anyone who subscribed to the WHOLE agenda before this release - a calendar
  app polling the bare `feed.ics?from=..&to=..` URL, or one pasted into Google Calendar. Their
  calendar stops updating (the app shows an error or an empty calendar) until they subscribe again
  from `/calendar`, whose modal now asks for a campus and/or formation. A subscription to ONE
  association (`?associationId=`) and the one-event link (`?eventId=`) are NOT affected. Nothing is
  lost server-side. An app installed before this release embeds the old frontend, so its subscribe
  modal and PDF export keep building the bare URL until it updates (the signed-in JSON feed keeps
  answering: it is narrowed to the reader's spaces).
- **Why nothing is removed later:** the refusal IS the rule. The day nobody has a bare URL saved it
  merely stops being hit; no branch waits to be deleted.

## Nothing to remove - an UNSIGNED calendar subscription now gets a 403 (2026-10-06)

**A second BREAK in two days, and again no shim.** `feed.ics` and the anonymous `calendar/feed` now
REFUSE a `campus` / `formation` / `associationId` selection that carries no valid `sig`: a 403 with code
`AGENDA_SIGNATURE_REQUIRED` (absent) or `AGENDA_SIGNATURE_INVALID` (wrong), `associations/agenda-signature.ts`.
The user decided it on 2026-10-06 ([D40 amended](profiles-and-access.md#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06)):
a subscription is restricted to the reader's own spaces by a signed URL, and the old ones are NOT honoured.

- **Who is affected:** every calendar subscription saved from `/calendar` between the D40 release
  (selection URLs `?campus=..&formation=..`) and this one, and any association subscription saved
  before (`?associationId=..`). The calendar app shows an error or an empty calendar until the reader
  subscribes again from `/calendar` or the association's page; the modal says so (`calendar_subscribe_old_links_notice`).
  The single-event link (`?eventId=`) is NOT affected. An installed app embeds the old frontend, so its
  modal builds unsigned links until it updates: they are refused.
- **Why nothing is removed later:** the signature IS the rule. Rotating `AGENDA_SIGNING_KEY` repeats this
  break on purpose (it is the revocation) and needs no code.

## Nothing to remove, revisit 2027-10-13 - an UNSIGNED salon row now gets a 400 (2026-10-13)

**A BREAK, not a shim.** `POST /api/channels/:channelId/messages` refuses a row with no Graine v2
`signature`: a 400 with code `CHANNEL_SIGNATURE_REQUIRED`, logged `[CHANNEL_SIGNATURE] REFUSED` at
ERROR (`ChannelService.assertSigned`,
[channel-encryption 21.8](protocols/channel-encryption.md#218-the-server-refuses-an-unsigned-salon-row-2026-10-13)).
It became possible when `minClientVersion` reached `1.0.3` (2026-10-11), the first release that
signs every row.

- **Who is affected:** no admitted client. A build below `1.0.3` cannot unlock MLS, so it cannot
  seal a salon row at all. The only sender left is a process unlocked BEFORE the floor rose and still
  running older code: its salon send shows the generic refusal and is not retried. And a modified
  client minting v1, which is the point.
- **The constraint it adds:** the floor must never go back below `1.0.3`. §21.7 already required it.
- **Why nothing is removed later:** the refusal IS the rule. **Revisit on 2027-10-13** (365 days after
  this refusal, the retention window): every unsigned row predates it, so the count in the v1-reader
  entry above should then read 0. That is when the v1 reader, the nullable column and the optional
  DTO field go together - and if it does not read 0, the salons keeping the old rows are named, not
  the date.

## No date - `GET /api/mls/history/:groupId` answering with a bare array

**The gate does not reach this one, and the page used to claim it did.** Retiring it is not a matter
of which clients are alive: **the replacement has never shipped**. Every deployed client, 0.14
included, reads the head out of `X-History-Head`, so changing the body today breaks the current fleet
rather than an old one.

**Site:** `MessagingController.getHistory` (the body stays `Record<string, unknown>[]`, the stream
head goes in the `X-History-Head` response header) and `MlsDeliveryApi.fetchHistory` (a page whose
`head` is `undefined` walks unbounded, exactly as before).
**Replacement:** the page IS `{ rows, head }`, one shape for both routes, and the head is not
optional - a walk always knows its upper bound. The batch route already has it: its response was
always an object, so `heads` was simply an added field.
**Condition, in order and it is a chain:** ship `{ rows, head }` and a client that reads it in some
release **R**; raise `minClientVersion` past **R**; then delete.
**On removal:** return `{ rows, head }` from the GET, delete the `res.setHeader` and the
`@Res({ passthrough: true })` it needs, drop `X-History-Head` from `exposedHeaders` in `main.ts`, and
make `HistoryPage.head` required.
**Why the header needs the CORS entry, for whoever ships R:** the app runs cross-origin under Tauri
(`http://tauri.localhost`), and a response header absent from `Access-Control-Expose-Headers` is
invisible to the client reading it. Without that line the bound would have been silently missing on
mobile only - green build, green deploy, wrong behaviour.
**Cost of keeping it:** two shapes for one concept, and a head typed optional at every use site
though the server always sends one. No correctness cost: a missing head means an unbounded walk,
which is what every client did before the bound existed.

---

Retired shims are not listed here. Each one's story is in `CHANGELOG.md` at the release that removed
it - `history_bundle` with no `to` and `history_request` with no `withDigest` on 2026-08-12,
`history_bundle` with no `since` on 2026-08-17.
