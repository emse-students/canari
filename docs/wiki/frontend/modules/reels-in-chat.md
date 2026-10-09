# CanaReels in a conversation - an ephemeral video message (DESIGN STUDY, decisions taken 2026-10-09; RC-1 reader in review)

**Decided by the user, 2026-10-09** (French, relayed): generalise CanaReels *like Snapchat*, so a
member can SEND a reel in a group, a DM or a community salon. **The chosen form is an EPHEMERAL VIDEO
MESSAGE filmed in the chat - end-to-end encrypted like any message, expiring like a reel (30 days) -
and NOT a link to a published public reel.** This page is the study that precedes the build: it reads
the code and wiki as of `main` at `13d633aec` (2026-10-09), decides what can be decided, and names what
the user must rule on. **No product code was written by the study.** **The user's rulings of 2026-10-09 are recorded in
section 9, and where the text below still says otherwise (it was written before them) section 9
wins.** The published reel (feed, public, post row)
stays exactly as [reels](reels.md) and [reels (server)](../../services/reels.md) describe it.

**Not on `main` when this was written: `docs/wiki/frontend/offline-and-weak-network.md`** (searched on
`origin/main` after a fetch; no open pull request found by title). Section 5 therefore states what the
weak-network work must provide and WP-RC-5 is blocked on it; when that page lands, reconcile the two
before building (the upload path below is the one most likely to overlap).

## 0. What is reused, what is new - in one table

| Piece | State today | In a conversation |
| --- | --- | --- |
| Camera, one shutter (tap = photo, hold = video), 90 s ring, framed capture | `ReelCapture` / `CameraScreen` / `framedCapture.ts` ([reels](reels.md#the-capture-screen-c4)) | **reused as is** behind a `destination` prop |
| Review: full-bleed, looping, top mute, editor, sound removal | `ReelReview`, `ReelEditor` ([reel-editor](reel-editor.md)) | **reused as is**; its "Suivant" becomes "Envoyer" |
| Publish step (caption, identity picker) | `ReelPublishSheet`, `publishReel.ts` | **not used** (no identity, no feed); an optional caption reuses `MediaMsg.caption` |
| Preparation on the phone, one H.264/AAC MP4 | `prepareVideoForUpload` ([video-preparation](../video-preparation.md)) | reused with a **chat profile** (lower bitrate, section 4) |
| Segmented encryption, ranged reads, streamed play | `mediaSegmented.ts`, `PostMedia` ([media-service](../../services/media-service.md#segmented-media-play-while-downloading-canareels-r2---the-reader-release-2026-10-01)) | reused for the full-screen viewer |
| The CEK inside the MLS / Graine body | `MediaMsg.key` ([channel-encryption](../../protocols/channel-encryption.md)) | reused: nothing about key custody changes |
| Retention class `reel` + social-service worker | posts only | **not reusable**: a conversation has no social-service row (new class, section 2) |
| A message type | `MediaMsg` (`MEDIA_KIND_VIDEO`, `voice_note` precedent) | **one declared intent field**, not a new top-level message |
| Tombstone when the blob is gone | `410` + `MediaPurgedError` on every media surface | reused, with a reel-shaped tile |
| Push for a message | decrypted on device (Android service, iOS NSE), `mediaKind` carried | one new kind and two strings per language |

## 1. Entering the camera from a conversation

**An OVERLAY over the conversation, never the `/camera` tab.** The tab is a swipe place left of the feed
(`CAMERA_PLACE`, [reels](reels.md#the-tab-c5)) and its origin logic (`cameraOriginFrom`) returns to a
PATH. A conversation is selected by state, not by a route a Back can restore (`notifNav`, the
`conversationId` in the layout), so leaving through the tab and coming back would drop the draft, the
scroll position and the selected conversation. So `ReelCapture` is mounted by the conversation itself
inside a full-screen layer carrying `fullscreen-place-open` on the document (today set from
`isFullScreenPlace`, a ROUTE predicate: the overlay needs the same class, set and removed by the layer),
and it takes the same history entries a take already takes (`pushHistoryOverlay`), so Android Back and
the iOS edge swipe end a recording, then discard a review, then close the camera - the contract of
the tab, unchanged.

**The prop.** `ReelCapture` gains `destination: { kind: 'feed' } | { kind: 'conversation', target }`
(`target` = the chat target the composer already holds: a DM or group conversation id, or a channel
id). `feed` is the current behaviour byte for byte. `conversation` changes exactly three things:

1. the review's primary action is "Envoyer" (it opens NO publish sheet - there is no identity to
   choose and nothing to caption mandatorily);
2. the 90 s ceiling comes from the same `GET /api/posts/reel-limits` call, so there is still ONE copy
   of the number (**decision: the chat shares C4's 90 s**, the user said "the 90 s limit"; a shorter
   chat cap is a one-line change in that route's answer, never a client constant);
3. the take is handed to the conversation's pipeline (section 2 and 5), **not** to `publishReel`, and the
   camera closes at once - the member returns to the conversation and watches the bubble work.

**The entry points (composer).**

| Where | Control | Notes |
| --- | --- | --- |
| Composer, EMPTY field | a camera button beside the microphone (Snapchat's place) | disappears when text is typed, as the mic does; the mic keeps its own hold gesture, the camera is a TAP target - two hold gestures side by side is how a slide turns into the wrong one |
| The composer's "+" menu ([chat](chat.md#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02)) | an entry "CanaReel" | the discoverable path and the desktop one; same handler |
| Camera inside the overlay | exactly the tab's controls | the camera opens on the FRONT lens (`CameraSession.facing` starts at `user`) |

**Tap vs hold inside the overlay.** The shutter is unchanged: a HOLD films a reel. A TAP takes a photo,
and **a photo from this camera goes out as an ORDINARY image message, not a reel** - the same rule the
feed applies (a photo is published as an ordinary post because "a reel is exactly one video",
[reels](reels.md#one-shutter-and-a-capture-that-is-the-preview-2026-10-05)). It is the one place a
member could expect ephemerality and not get it, so the review for a photo says "Photo" and not
"CanaReel" (decision D6, section 7: do the user want ephemeral photos as well - a different class and a
different bubble, a later package, not smuggled in here).

**Accessibility of the gesture.** The tab's shutter has been hold-only since 2026-10-05, and a hold
is not available to every hand. The conversation overlay adds an accessible alternative at once: the
shutter exposes `role="button"` with `aria-pressed` toggling record/stop through the keyboard
(Space/Enter) and a "tap to start, tap to stop" lock offered by a short sliding gesture, as Snapchat's
lock is. The same alternative should then be given back to the tab (a separate, small fix noted in
section 6; the study does not widen the scope).

## 2. The message model

### 2.1 One message type, two declared fields

**No new `AppMessage` kind.** A reel message is a `MediaMsg` with `kind = MEDIA_KIND_VIDEO`, the
declaration the sender alone can make, exactly as the voice note did: `voice_note = 11` was added
because "a voice note and an imported `.m4a` are the same bytes" and a file-name rule is "a distinction
carried in prose that the next file manager breaks" ([chat](chat.md)). A camera take and a picked clip
are the same bytes too. So `MediaMsg` gains (field numbers to be taken from the proto at build time):

```proto
// How this media was made and what it is for. DECLARED BY THE SENDER; 0 reads as an ordinary attachment.
enum MediaIntent { MEDIA_INTENT_NONE = 0; MEDIA_INTENT_REEL_MESSAGE = 1; /* 2 reserved: VIEW_ONCE (section 3.4) */ }
MediaIntent intent      = 14;
uint32      duration_ms = 15; // declared, drawn on the tile before a byte is fetched; never trusted for a limit
int64       expires_at_ms = 16; // display hint (section 2.4); the SERVER's clock is the authority
```

An enum, not a bool, because the decided later mode (view once) is a second value, and because an
unknown VALUE must be read as "ordinary video", never as an error.

**Compatibility is free in the direction that matters.** A client older than the build reads the
message as an ordinary video attachment (proto3 skips unknown fields; `MediaRef` decoders drop what
they do not know). It plays it like a chat video, from a bubble with a download - which is a
softer ephemerality (it can save it, see 3.3) but never a broken message, and the blob still goes at
30 days. **This is the one reason the intent must not be the file name or a mime parameter.** No
`minClientVersion` bump is needed for the plain reel message; **view once WOULD need one** (an old
reader would treat it as a durable video), see 3.4.

**The payload, field by field**, all inside the MLS application message (DM/group) or the Graine body
(salon) - so the server never sees any of it:

| Field | Source | Notes |
| --- | --- | --- |
| `media_id` | the upload's answer | opaque |
| `key` (CEK), `iv`, `encoding = SEGMENTED_V1` | `encryptAndUpload` | segmented, so the viewer streams |
| `mime_type` | the prepared file's `type`, codecs included | `chooseSegmentedPlayback` reads the codecs from it |
| `size` | plaintext bytes | |
| `width`, `height` | `PreparedVideo` | 720x1280-ish: reserves the 9:16 box before the first byte |
| `duration_ms` | `PreparedVideo.durationSeconds`, clamped to the cap as `declaredReelDurationMs` does | |
| `placeholder` | a ThumbHash of the FIRST frame | existing field 13, the box paint ([media-frame](../media-frame.md)) |
| `caption` | optional text typed in the review | existing |
| `intent`, `expires_at_ms` | new | |

**No separate poster blob.** The bubble paints the ThumbHash (25 bytes, blurred) and a play glyph; it
fetches nothing before a tap. A recognisable poster would be a second upload under the same class, an
extra leak in a notification preview or an OS-level thumbnail, and Snapchat itself shows an opaque tile
on purpose. Owed to the user as D5 only if they want a real preview frame (it would be a <= 24 KB JPEG
carried as `bytes poster`, encrypted with the rest, and nothing else changes).

### 2.2 The retention class: a NEW one, swept by AGE, by media-service alone

The published reel's `reel` class cannot be reused: its lifecycle belongs to social-service (the
claim after publication, the hourly `ReelRetentionScheduler` selecting due ROWS, then calling
`reel-purge` per owner - [reels (server)](../../services/reels.md#the-retention-class-reel-and-the-claim)).
A DM or a group message has no social-service row, and the message queue is chat-delivery's. Making a
conversation reel depend on a social-service row would invent a table to hold a clock.

So media-service gains a fifth class, **`chat-reel`**:

| | |
| --- | --- |
| Set by | the client at upload (`encryptAndUpload`'s REQUIRED class argument, so no call site can forget it). A client labelling something `chat-reel` gains only a SHORTER life (30 days from upload against 90 days idle) - nothing here can make a blob last longer, which is why the client may set it, unlike `association` |
| Swept | **by AGE from `createdAt`, not idleness** (`lastAccessAt` is refreshed on every download: an idle clock would let a reel watched every 29 days live for ever, the opposite of the decision). Window: `CHAT_REEL_RETENTION_DAYS = 30`, ONE constant in media-service, overridable by env on the bench so a verification can cross it |
| Mechanism | the existing sweep (boot, hourly, on `download()`), whose allowlist predicate `isSweepable` is the ONE copy (`getStorageStats` calls it too): it gains `chat-reel && createdAt + window < now`. **Still an allowlist** - nothing becomes sweepable by omission |
| Tombstone | the existing tombstone with `purgeReason = reel_expired` (the 90-day tombstone trim stays), so the client's `410` handling needs no new wire shape |
| Account deletion | takes it (`removeAllOwnedBy`), like `reel` |
| Stats | `chatReelCount` / `chatReelBytes` and an `overdue` figure on `/admin/storage` - an exempt or new class folded into a total is one whose growth nothing can see |
| Deleting a message for everyone | the sender's client calls a new owner-only `DELETE /api/media/:id` for a `chat-reel` blob. Allowed here and refused for ordinary media because **a reel message cannot be forwarded** (3.3): the "a blob can be cited from conversations the deleter cannot see" reason in [media-service](../../services/media-service.md#retention-a-90-day-idle-sweep-on-chat-media-and-nothing-else-deletes-them) does not apply. The owner check is the allowlist, as in `reel-purge` |

**Cost to decide, with a number.** A 90 s reel at the post profile is ~28-35 MB of ciphertext, kept 30
days; one blob serves a whole group (the CEK is shared, the ciphertext is stored ONCE). At the chat
profile (section 4) it is ~14-17 MB. The storage forecast ([storage-forecast](../../infrastructure/storage-forecast.md))
has to be re-read with the expected sends per active member per day before the build ships (WP-RC-0 owes
it: nothing here has been measured on production).

### 2.3 Salons

A community salon message is server-authoritative and carries its encrypted body in `channel_messages`
(Graine v2: the author is proven, the ciphertext is bound to its place,
[channel-encryption section 21](../../protocols/channel-encryption.md)). The `MediaMsg` rides in that
body like any attachment, so nothing in the cryptography changes. Two things are salon-specific:

- **The row outlives the blob.** `channel_messages` keeps messages for 365 days
  (`CHANNEL_MESSAGE_RETENTION_DAYS`); the reel's blob goes at 30. The bubble is therefore a tombstone
  for eleven months, which is the intended behaviour and the reason the tile must read well expired
  (2.4).
- **A moderator can delete the message, and the blob must go with it.** Social-service holds the
  author (`channel_messages` is the place the proven author lives), so it calls an internal
  `chat-reel-purge { mediaId, ownerId: <author> }` - the same ownership allowlist as `reel-purge`,
  never "class is chat-reel". A moderator is not the uploader, and the allowlist still holds because
  the OWNER named is the author the row proves.

**To verify before the build (WP-RC-0, not asserted here):** who may `GET /api/media/:id` for a blob a
salon message cites - the table says "owner or group member", and a salon has no MLS group in that
sense. If any JWT may fetch it (a member who left keeps the CEK only if they cached the message, but
the blob stays fetchable until it expires), say so in the page and accept it explicitly: it is
consistent with every other salon attachment today.

### 2.4 What the recipient sees after expiry

A **tombstone tile**, not a vanished message and not an error: the same 9:16 box, no ThumbHash (an
expired ephemeral should not keep a blurred ghost of itself), the label "CanaReel expire" and the age
of the message. Two facts make it, in this order:

1. the message's own `expires_at_ms` (a DISPLAY hint set by the sender from `sentAt + 30 days`): the
   tile draws expired without a request. This exists because *never learn by failing what a fact could
   have told you* - without it the first sight of an expired tile costs a `410` per bubble per
   scroll. It is never the authority: a tampering sender can only SHORTEN, since the server sweeps on
   its own clock.
2. the `410` (`MediaPurgedError`) - the truth, for every early loss (account deletion, a moderator,
   the sender's delete) and for a hint that disagrees. `404` keeps its own `media_error_not_found`.

The message row, its reactions and replies stay (a conversation's history is not edited by a blob's
life). The caption survives under the tombstone only if the member wrote one - their words, not the
video's. **No "deleted in N days" chip** (the user ruled it out for the feed on 2026-10-02: it is "pas
discret"); a reel message shows its AGE like a reel does.

## 3. The viewer

### 3.1 In the conversation: a tile, not a player

`MessageMediaRenderer` gets a branch for `intent === REEL_MESSAGE` BEFORE the generic video branch (and
**the study repeats the lesson of #1229: that file once lost every photo to the video branch and no test
had ever mounted it - this branch needs a mounting test on day one**). The tile is 9:16 at the media
width the chat already fixes (`w-68`, a fixed width, never a percentage), drawn from `width`/`height` so
the layout never shifts; ThumbHash fill, a play glyph, the duration (`0:42`), the caption in the bubble
as for any media.

- **No autoplay, no prefetch in the bubble.** The chat reads media WHOLE (bubbles do not stream) and a
  reel is 14-35 MB; auto-fetching it on arrival would spend a member's mobile data on a message they
  may never open and would defeat the whole weak-network posture (section 4). The tile fetches on
  TAP.
- States the tile draws, each a typed state, never a string compare: `idle`, `fetching` (a ring and the
  fraction), `failed-retryable` (a retry), `expired` (2.4), `sending` / `failed-send` for the sender
  (section 5).

### 3.2 Full screen: the existing viewer, single-slide plus the unseen ones

A tap opens `ReelViewer` in a **conversation mode**: the touched reel first, then the other reel
messages of THIS conversation in the order the member would watch them - Snapchat's chain. The
vertical swipe/next machinery, the preload of the next one, the single mounted player and the "ONE
sound answer" are `reelViewerNav.ts` / `reelPreload.ts` / `VideoPlayer` unchanged; only the source of
the list changes (the conversation's loaded messages instead of `GET /api/posts?kind=reel`). The
viewer plays through `PostMedia` in gallery mode, i.e. it STREAMS a segmented blob as it arrives.
Chrome in the viewer: close, the sender's name and age, the caption, **no** save, **no** share, **no**
forward (3.3), mute follows the app's one sound switch (muted until the member has turned sound on
anywhere, the rule `VideoPlayer` already enforces), loop on.

**Autoplay muted vs sound.** On open it plays (a tap is a user gesture, so the engine's autoplay policy
allows sound); sound follows the app-wide switch, exactly as a published reel does. No second setting.

### 3.3 Save, forward, screenshot - what is and is NOT preventable

| Action | Policy decided here | What is truly preventable |
| --- | --- | --- |
| The SENDER saves their own take | allowed, at the review ("Enregistrer", `ReelSaveButton` + the gallery plugin, C6) - the member's own footage, kept before it is gone | n/a |
| The RECIPIENT saves | **no button in v1** | a button is a courtesy, not a barrier (below) |
| Forward / copy | **not offered** for a reel message; the action sheet drops them | forwarding copies the `MediaRef` (so the CEK) - a modified client can always do it |
| Screenshot | not blocked, not announced | **Web/desktop: nothing.** **Android: `FLAG_SECURE` blocks screenshots and screen recording of the viewer** (also blanks the app-switcher thumbnail) but is native work on the window and still loses to a second phone. **iOS: no supported way to block a screenshot**; `UIScreen.isCaptured` and the screenshot notification can DETECT, and the secure-text-field trick can blank a recording, but it is undocumented and brittle |
| Screen recording | same | same, Android 14+ also offers a capture callback |
| A camera pointed at the screen | nothing | nothing, anywhere |
| A modified client or devtools | nothing | the recipient's client holds the CEK and fetches the ciphertext; whoever runs it can write the plaintext out. The 30-day deletion removes the SERVER's copy, not what a recipient kept |

**What the product may therefore claim, and what the UI must never say.** "Disappears after 30 days"
is true of the server's ciphertext. "Cannot be saved" is NEVER true and the copy must not suggest it
(no "protected" badge, no "screenshots are blocked"). The sentence for the sender, once, in the review:
"Ce CanaReel est supprime des serveurs apres 30 jours. Un destinataire peut toujours en garder une
copie." (D4: whether to add `FLAG_SECURE` on Android anyway, as a deterrent that costs a plugin
command and a per-viewer toggle - recommended **no** for v1, because a protection that works on one
platform of three is a promise with a hole in it.)

**A reel's local copy.** The ciphertext sits in the Cache API (`canari-media-ciphertext-v1`) and the
decrypted blob URL in the pool for 5 minutes. For a `chat-reel` message the cache entry is dropped at
the expiry (the hint, then the `410`) and the blob URL is revoked when the viewer closes; the Cache
API's persistence is otherwise a "kept after the server forgot it" copy that the tombstone would
contradict.

### 3.4 Read semantics, and "view once" as a later, partial mode

**Read.** Today a read receipt is a per-conversation WATERMARK (the last message a member read), drawn
as heads under that message and for a salon the server's `read-marks`
([chat](chat.md)). It says "reached the screen", not "watched". For a reel message that
is the wrong grain only if the product wants to say "OPENED". Recommendation for v1: **change nothing**
- the reel tile counts as read when it is on screen like any bubble, the heads say who has been past
it, and NO "opened" signal exists. A distinct "Ouvert" is a per-message, per-recipient fact that in a
group reveals WHO watched (a viewers list, Instagram's, which the feed does not have for reels
either) - a privacy decision, not an implementation detail (D3). If the user wants it, it is a silent
control event (`reel_opened { message_id }`, the same family as reaction/edit/read, "Every message
mutation travels as a control event", [chat](chat.md)), DMs first, and the sender's tile says
"Ouvert".

**View once (optional, LATER, and honest about what it is).** What it can guarantee in an E2E app is
narrow, and the study lists the holes so nobody sells it as stronger:

- *A DM (two people)*: the recipient's client, on the first full open, (1) tells the server to delete
  the blob (a new owner-or-recipient allowlisted route - the "owner" here is not the caller, so the
  allowlist needs a second rule: the named DM peer), (2) drops the Cache API entry and the URL, and (3)
  rewrites its own stored message row to the tombstone. **It guarantees the SERVER's copy is gone
  after the first view by an honest client.** It does NOT guarantee the recipient did not record it, and
  a recipient who fetches the ciphertext and never reports the open leaves the blob alive until the 30
  days - the delete is a client-asserted fact.
- *A group or a salon*: **not possible as stated.** One blob serves N recipients; deleting it on the
  first view denies it to the rest, and "deleted when all N have opened" needs per-recipient opened
  facts nobody can verify and a membership that changes. The only honest group form is per-recipient
  copies (N uploads of the same video under N CEKs) - a different cost model, not proposed.
- *Old clients*: an older reader would show a view-once as an ordinary video that outlives the
  promise. It therefore needs a `minClientVersion` at or above the reader that understands
  `VIEW_ONCE` - and is gated like the Graine writer was (reader release first).
- *Multi-device*: the same account's second device holds the same message; "once" would have to be once
  per ACCOUNT, i.e. another cross-device fact.

So: **view once is a DM-only, best-effort, honest-client feature, shipped after the plain reel message
has run for a while, and labelled as such.** It is not in WP-RC-1 to 8.

## 4. The weak network

**A reel is 14-35 MB, the one big thing a chat message has ever carried, so the weak-network posture
is the feature, not a polish.** What the code does TODAY, read from it:

- **Preparation is a foreground, in-WebView encode.** Measured 2026-10-01: a 20 s clip took 8-28 s on
  the two phones ([video-preparation](../video-preparation.md)); a 90 s take is **unmeasured** (WP-RC-0).
  It runs in the WebView, so a backgrounded app can pause it (iOS suspends) and a killed app loses it.
- **Upload is ONE POST up to 50 MB.** `media.ts` only chunks above `CHUNK_SIZE = 50 MB`, and a ciphertext
  cannot exceed the 50 MB ceiling - so **a reel is always a single request with no resume**: a cut at
  90 % restarts from byte 0. (The chunked routes exist - `upload/chunk/init`, `/:id`, `/complete` - but
  nothing reports how many bytes the server holds, and a chunk may be as big as 50 MB.)
- **The outbox persists a queued media file INSIDE the row** (`outboxCodec.ts`: `fileBytes` ->
  `fileBytesB64`), then, once uploaded, keeps only the `uploadedRef` (idempotent, a crash after the
  upload does not re-upload). A 28 MB prepared video is a ~37 MB base64 string in one row, in a
  database that mirrors to disk and, on the phones, to a native copy (`outbox_pending.ndjson`,
  [mobile](../mobile.md)). That is the wrong place for it.

**The design, in order of what it needs from whom:**

1. **A chat PROFILE for the preparation** (`prepareVideoForUpload` option, `videoEncodingPlan.ts` the
   only copy): short side 540 px, ~1.2 Mb/s, 30 fps, AAC 96 kb/s, bounded by `maxBytes`. At 90 s that
   is ~14 MB instead of ~28-35 MB, and the post profile stays 720p/2.5 Mb/s untouched. **The trade is
   real**: a chat reel is smaller and softer than a feed reel. D2 (the user decides the numbers); the
   code makes it a profile table, not a second pipeline, because C3's "one format" is about the CONTAINER
   and codecs, which do not change.
2. **A raw-take safe place before anything else.** The recorder's `Blob` is written to a file in the app's
   cache directory (OPFS or the native cache) the moment the take ends, so a kill during preparation
   loses nothing, and the camera can close.
3. **The prepared file is stored OUTSIDE the outbox row**, in a blob store keyed by the entry id; the row
   carries a reference and the size. The row stays kilobytes; the file is deleted when the entry is
   sent or dismissed. The send is queued like any media message - the existing outbox states and
   `uploadedRef` idempotence are reused, not rebuilt.
4. **A resumable upload with small parts, REQUIRED of the weak-network work and of media-service**:
   parts of 1 MiB aligned to the segment size (so a part is a whole sealed segment and the server needs
   no knowledge of the cipher), a `GET /api/media/upload/chunk/:id` answering the byte count the server
   holds, and the client resuming from it after any failure - **a fact the server reports, never a
   guess by the client**. Under 1 MiB per request, a Mi 9T on a flaky 3G does not lose 30 MB to one
   timeout. This is the dependency: if the weak-network page already decides a resumable upload for
   media in general, this design defers to it and WP-RC-5 shrinks to wiring.
5. **The sender sees the truth.** The bubble goes `preparing 43 %` -> `sending 12 %` -> `sent`, cancel
   at every stage, `failed` with a retry that resumes; the member may leave the conversation (the outbox
   owns it). Offline: queued exactly like a text; the prepared file waits locally; the flush uploads
   when `canFlush` opens (the outbox's gate, which "answers MAY I SEND", not "now").
6. **The recipient's data is protected by the tile**: nothing downloads before a tap (3.1); the
   viewer streams the first segment (R2) so playback starts without the whole file; the preload of the
   NEXT reel in the conversation is skipped on a metered or slow connection (the same signal the
   weak-network work defines).
7. **Caps, in the server's voice**: the 50 MB ciphertext ceiling still holds and `too-large` stays the
   typed refusal; the 90 s comes from `reel-limits`; a per-member daily byte cap for `chat-reel` is a
   decision (D7) so one account cannot fill the store - proposed 500 MB/day, enforced by media-service
   from `ownerId` (the only attribution it has), answered `429` as an ANSWER and never retried blindly.

**Prepare while the member reviews?** An optimisation, not a requirement: start preparing when the
review opens and throw the result away if the member edits (a stroke or removing the sound changes the
input). It hides ~10-30 s of encode behind the member's own look at the take. Left to a later package
(WP-RC-11) because it costs battery on takes that are discarded.

## 5. Platforms - and which parts need native work

| Part | Web | Desktop (Tauri) | Android | iOS |
| --- | --- | --- | --- | --- |
| Camera, review, editor | `getUserMedia` | the same | the app's WebView, the existing camera permission | the same; iOS asks mic then camera ([reels](reels.md#the-first-camera-open-read-on-both-phones-2026-10-01-before-anything-was-built-on-it)) |
| Preparation (WebCodecs + mediabunny) | works where WebCodecs does | **WebKitGTK on Linux: unmeasured** - WP-RC-0 reads it | measured 2026-10-01 | measured 2026-10-01 |
| Raw-take / prepared-file store | OPFS | OPFS or the cache dir | the cache dir via the existing plugin, or OPFS | same |
| Resumable upload, tile, viewer | web | web | web | web |
| **Push text and kind** | n/a (no push) | n/a | **native Kotlin**: `mediaKind` gains a reel value; two strings | **native Swift in the NSE** (and `canari_push.mm` for the in-app path): the same, in the NSE's OWN `Localizable.strings` (an appex is a separate bundle) |
| Deterrent against capture | none possible | none | `FLAG_SECURE` is native, optional (D4) | none supported |
| Save own take | download | download | gallery plugin (exists) | gallery plugin (exists) |

**So the build is almost entirely shared TypeScript.** Native work is limited to the push surfaces
(about a Kotlin branch and a Swift branch plus strings and their tests) and an optional Android window
flag. The camera needs none - the point of building the capture screen in the WebView.

## 6. Push, moderation, accessibility, i18n

### Push text

Push for a DM or group message is composed ON THE DEVICE from the decrypted message
(`CanariFirebaseMessagingService.kt` reads `mediaKind` as `image | video | audio | file`; the iOS NSE
the same), in the LANGUAGE THE MEMBER CHOSE, from tables that the app mirrors into `push_context.json`
([mobile](../mobile.md#the-language-a-notification-speaks)). The server writes no sentence for a chat
message and cannot: it holds ciphertext. So:

- `mediaKind` gains `"reel"` (derived from `intent`, NOT from the mime type, or a picked clip would
  read as a reel). The composer maps it to a line: DM `"<name> a envoye un CanaReel"` / `"<name> sent a
  CanaReel"`; group and salon `"<name>: CanaReel"` in the existing group format; with a caption the
  caption follows, as it does for a photo. **No emoji in the string** (the repo's ASCII rule applies to
  dev-facing text; the user-visible strings are Paraglide/`strings.xml`/`Localizable.strings`, three
  tables kept in step - the NSE's own copy included).
- **No thumbnail, ever.** `decrypted.mediaKind != "image"` already returns null for the notification
  picture (`CanariFirebaseMessagingService.kt`); a reel must keep returning null. Decrypting a 14-35 MB
  blob inside a background service to draw a preview would be the wrong cost and an exposure the tile
  deliberately avoids.
- When the decrypt fails (a newer epoch in the NSE, [mobile](../mobile.md)) the generic line stays as
  it is for every message - no new fallback.
- Muting, "do not disturb" and per-conversation settings are the conversation's, unchanged.

### Moderation and the report path

**The honest limit first**: a DM or group message is ciphertext; the server has nothing to show a
moderator, and [moderation-and-blocking](../../moderation-and-blocking.md) removed `message` from
`content_reports` for exactly that reason ("reporting a message would mean the client attaching the
decrypted excerpt, which is a privacy decision about what a reporter discloses"). A reel is a harsher
case of the same: a video cannot be an excerpt. So:

| Surface | What exists / is proposed |
| --- | --- |
| DM, group | **Block** (a block is between two people, silent) and **report the USER** (`contentType: 'user'`, exists). No server-side removal of an E2E message. Optional later (D8): "report this message" where the reporter chooses to DISCLOSE the CEK and `mediaId` so a moderator can fetch and decrypt the video - an explicit act, in the report, never automatic |
| Salon | The community's existing moderator delete, which now also purges the blob through the allowlisted internal route (2.3); the salon's report path is whatever the salon has, plus the user report |
| A reel ABOUT to be sent | a mute check at send, as `publishReel` does ("the mute check"): a muted member cannot send a reel to a community they are muted in |

A hidden-by-moderation salon message must hide the tile too (the renderer reads the same row flags as
any message). **A reel message is not forwardable (3.3), which is also a moderation property**: it can
only be as widely seen as the audience it was sent to.

### Accessibility

- The tile is a real `button`, with an accessible name built from typed parts: "CanaReel de <name>,
  0:42, envoye il y a 3 h" (and "expire" for a tombstone), never from the caption alone.
- The viewer announces open/close, has a visible close, an Escape key and the arrow keys (the wide-screen
  step buttons exist), and respects `prefers-reduced-motion`: no swipe animation, **no autoplay-on-open
  motion** - the player starts paused with a visible play control (an OS-level reduced-motion member
  should not be handed a looping video).
- A reel has no captions (no speech-to-text exists here). The mitigation is the optional TEXT caption
  the sender types, read by the screen reader, and the sound-off default that makes the video usable
  without audio. Said plainly in the page so nobody claims otherwise.
- The hold-only shutter needs the toggle alternative (section 1).
- Focus returns to the tile that opened the viewer. Contrast: the tile's glyph and duration sit on a
  scrim token, never a raw colour (design-reference).

### i18n keys (Paraglide, French default, English second; none inline)

`reel_chat_camera_button` ("Camera"), `reel_chat_attach_entry` ("CanaReel"), `reel_chat_send`
("Envoyer"), `reel_chat_photo_note` ("Cette photo sera envoyee comme une image ordinaire"),
`reel_chat_sender_note` (the 30-day sentence of 3.3), `reel_chat_preparing`, `reel_chat_sending`,
`reel_chat_send_failed`, `reel_chat_send_retry`, `reel_chat_tile_label` (the accessible name, with
parameters), `reel_chat_expired`, `reel_chat_expired_label`, `reel_chat_open_error`,
`reel_chat_muted_in_community`, and the viewer's `reel_chat_viewer_*` set. The two native push strings
(`notif_reel_dm`, `notif_reel_group`) live in the three platform tables, not Paraglide.

## 7. The work packages, in order

Each is one pull request, small, with its test named, and none starts before the one it names. Efforts
are for one engineer including tests, in days.

| WP | What | Tests / verification | Effort | Needs |
| --- | --- | --- | --- | --- |
| **RC-0** | **Measure and audit, no code.** Prep time of a 90 s IN-APP take on both phones at the post profile and a chat profile (output size, thermal); WebCodecs on WebKitGTK; the salon media-download access rule (2.3); outbox row size with a real 14 MB and 28 MB payload; the storage forecast re-read with an expected volume; the weak-network page's decisions | numbers and a table added to this page; nothing merged but docs | 1.5 | the weak-network PR on `main` |
| **RC-1** | **The wire contract**: `MediaIntent`, `duration_ms`, `expires_at_ms` in `MediaMsg`; `MediaRef` / `MediaEnvelope` / `OutboxMediaPayload` carry them (written ONLY when set, as `voiceNote` is, so an old message reads unchanged); bindings regenerated | proto round trip both ways, the envelope decoders drop an absent intent, an unknown value reads as ordinary, an OLD reader fixture still plays | 1 | RC-0 |
| **RC-2** | **media-service `chat-reel`**: class, age sweep through `isSweepable`, `reel_expired` tombstone, stats and the `/admin/storage` line, owner `DELETE`, the env-overridable window; client `encryptAndUpload` accepts the class | unit: sweep by age not idleness, allowlist (an untouched `reel`/`archive`/`association`/none), tombstone reason, stats, owner-only delete; **real** media-service over HTTP on the bench with the window shortened | 2.5 | none (parallel to RC-1) |
| **RC-3** | **The chat profile** in `prepareVideoForUpload` / `videoEncodingPlan.ts` | plan unit tests (sizes at 20/60/90 s fit `maxBytes`), and the device table of RC-0 re-run for the shipped numbers | 1 | RC-0 |
| **RC-4** | **Capture destination**: `destination` prop, the overlay layer with its history entries and `fullscreen-place-open`, the composer camera button and "+" entry, "Envoyer", the photo-as-image branch, the accessible shutter toggle, the mute check; i18n | component tests (the overlay mounts, Back ends take then review then layer, the photo goes the image path, the feed destination is byte-identical), harness row on both phones | 3 | RC-1, RC-3 |
| **RC-5** | **Outbox**: the raw-take store, the prepared file OUTSIDE the row, states `preparing`/`sending`/`failed`, cancel, resume; the resumable chunk upload and its server offset route | outbox tests for each state and a crash at each stage (no double upload, no lost take); chunk-resume unit on media-service; a throttled-network run (`offline-and-weak-network` is the model) | 4-5 | RC-2, RC-4, the weak-network PR |
| **RC-6** | **The tile and the viewer**: `MessageMediaRenderer` reel branch, tombstone, conversation mode of `ReelViewer`, no save/forward, cache hygiene at expiry, accessibility | **a mounting test of the branch** (lesson of #1229), every state, reduced motion, the action sheet drops forward/copy, `410` and the hint both draw the tombstone | 3 | RC-1, RC-2 |
| **RC-7** | **Push**: `mediaKind` reel on Android and the iOS NSE (and `canari_push.mm`), strings in the three tables, no thumbnail | Kotlin unit and strings-parity tests; on a phone with the app killed, a DM, a group and a salon each read on the lock screen (the device-verification check B pattern) | 2 | RC-1 |
| **RC-8** | **Salons and moderation**: the salon send path, social-service's moderator delete purging through `chat-reel-purge` (ownership allowlist), the user-report entry from the tile's menu, optionally the disclosed report (D8) | social-service unit and the real-database path for the delete; a moderator run on the bench | 2.5 | RC-2, RC-6 |
| **RC-9** | **Campaign rows and the hardware pass**: DM, group and salon, web + Android + iOS, a weak-network run, the 30-day crossing on a bench with the window shortened, an expiry read of every surface | new rows on [cross-client-testing](../../cross-client-testing.md) through `bun rows.mjs`; the user's look on both phones | 2 | RC-4 to RC-8 |
| RC-10 | *Later*: "opened" signal (D3), then view once for DMs (3.4, with its own `minClientVersion` gate) | its own study when asked | - | RC-9 |
| RC-11 | *Later*: prepare while the member reviews | measured battery cost on discarded takes | 1.5 | RC-5 |

**Total for the first usable version (RC-0 to RC-9): about 21-23 engineer-days.** The ordering puts the
two server/contract packages (RC-1, RC-2) first because everything else is blind without them, and the
pipeline (RC-5) before the UI polish because a reel that cannot survive a weak network is a feature
that works in the office.

**Release shape.** The reader (RC-1 contract + RC-6 tile, so every client can DRAW a reel message and
its tombstone) ships before the writer (RC-4 camera entry), the order used for Graine v2 and the
segmented media writer: a message a client cannot draw is worse than one it draws as a plain video.
RC-2's `chat-reel` class is server-side and safe to ship first (nothing sets it yet). The stable follows
the usual two-release sequence ([CLAUDE.md](../../../../CLAUDE.md) "gesture two") with a pre-release on dev
and the testers.

## 8. Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **Storage growth** | 30-day, ~14-35 MB each, any member, any conversation; the shared host measured 60 % used on 2026-10-09 ([backlog](../../backlog.md)) | RC-0 forecast, chat profile, the per-member daily cap (D7), the `/admin/storage` line and an `overdue` figure |
| **A 90 s preparation on a phone** | unmeasured; may be minutes on the iPhone 12 | RC-0 first; the raw-take store (a kill loses nothing); the review-time prepare (RC-11) |
| **The outbox holding the file** | a 37 MB row is the wrong shape | the file outside the row (RC-5) |
| **Single-request upload** | 90 % lost on a cut | the resumable part upload; depends on the weak-network work |
| **The promise** | "ephemeral" read as "private from the recipient" | the copy of 3.3, nothing claims screenshots are blocked, `FLAG_SECURE` is NOT the default |
| **Old clients** | draw a reel as a video with a download, which is softer than the promise | accepted for the plain reel (the server's copy still goes at 30 days); view once is gated on `minClientVersion` |
| **E2E means no server moderation** | a DM or group reel cannot be reviewed | block, user report, the optional disclosed report (D8); said on the page, not hidden |
| **Salon access rule unverified** | who may fetch the blob | WP-RC-0 audit; consistent with every salon attachment until proven otherwise |
| **Hold-only shutter** | a motor-access regression, now repeated in a chat | the accessible toggle in RC-4, then given back to the tab |
| **A branch no test mounts** | #1229 lost every photo to a video branch | the mounting test is a stated deliverable of RC-6 |

## 8b. What the reader package (RC-1) built, and what it did not (2026-10-09)

**Draft pull request, waiting for review after the 1.2.0 stable: it changes the wire format.** READER
ONLY - nothing in the app can send a reel message yet (no RC-4 camera entry, no RC-5 upload), so a
`REEL_MESSAGE` only ever arrives from a client built later.

- **Wire** (`libs/proto/canari.proto`): `MediaMsg.intent = 14` (`MediaIntent`: `NONE = 0`,
  `REEL_MESSAGE = 1`, 2 reserved for view-once), `duration_ms = 15`, `expires_at_ms = 16`. Written ONLY
  when set. An OLD client skips the three fields and plays the blob as a plain video (pinned by
  `codec.reelMessage.test.ts` against the schema as it stood); a client that knows the field but not the
  VALUE reads an ordinary attachment, never an error. The native push readers (Rust `proto_fields.rs`,
  Kotlin, Swift/NSE) read `MediaMsg` by field number and ignore the three, so a push still says "video"
  until RC-7: **compile-checked and unit-tested in Rust only, NOT run on a device.**
- **Model**: `MediaRef.intent / durationMs / expiresAtMs`, the stored JSON envelope, the outbox payload
  (`prepareMedia` writes the declaration; nothing sets it yet), `mediaReelProtoFields` /
  `mediaReelFromProto` in `proto/codec.ts`, the ONE place that spells the mapping.
- **Tile** (`ChatReelTile.svelte`, drawn by `MessageMediaRenderer` BEFORE the video branch): 9:16 box
  from `width`/`height`, ThumbHash fill, a play glyph, "Appuyer pour voir", the length. **Nothing is
  fetched before the tap**: `MessageBubble`'s download effect returns early for a reel message and the
  viewer downloads and streams. **Tombstone** once `expiresAtMs` has passed: same box, no ThumbHash, "CanaReel
  expire" and the age only. A `410` met INSIDE the viewer shows the player's own expired state; the tile
  behind it is only told by the hint (a tile that learned from the `410` would need the viewer to report
  back - left for RC-9 to measure).
- **Viewer**: the feed's `ReelViewer` on ONE post-shaped entity (`reelMessageAsPost`), `loadPage` empty
  (a conversation's reels are not the feed's; the chain through the conversation's other reels of 3.2 is
  not built). **The save button is in the bar next to the volume, for every reel** (D-save), so the feed
  viewer changed too. A reel message is NOT forwardable (the bubble drops the action).
- **Not built**: the sender, the retention class beyond the RC-2 draft, the resumable upload, push text,
  salons' moderator purge, the 60 s cap field in `reel-limits`, the chat encoding profile.

## 9. Decisions

### 9.1 Decided - the UI target is Snapchat (user, 2026-10-09)

| # | Decision | Ruling | Decided by, when | Replaces in this page |
| --- | --- | --- | --- | --- |
| D-view | Replaying a received reel | **Replayable for the 30 days of its life**; the tile reads "Appuyer pour voir"; **NO view-once now** (RC-10 stays later) | the user, 2026-10-09 | 3.4: view once stays a later, separate mode |
| D-size | Caps | **Chat cap 60 s**, profile **about 540p at 1.2 Mb/s** (about 9 MB at 60 s); published reels stay 90 s / 720p. The chat cap is a field of `reel-limits`, never a client constant | the user, 2026-10-09 | 1 (point 2) and 4 (point 1): "90 s" and "14 MB" now read 60 s and about 9 MB |
| D-opened | An "Ouvert" signal | **None**; the existing read receipts only | the user, 2026-10-09 | 3.4 (D3 closed: no) |
| D-save | Saving a received reel | **A SAVE button for ALL reels, public or not**, in the viewer bar NEXT TO THE VOLUME BUTTON (the existing `ReelSaveButton` and gallery plugin) | the user, 2026-10-09 | 3.2 ("no save"), 3.3 (the recipient row), D9 |
| D4 | `FLAG_SECURE` / screenshot blocking | **NOT USED, dropped from the design.** A save button beside a blocked screenshot would contradict itself. **The UI never claims protection**: no "protected" badge, no "screenshots are blocked"; the sender's note says only that the SERVER copy goes after 30 days | follows D-save (the user), 2026-10-09 | 3.3 (the Android row), 5, 8 |
| D5 | Poster on the tile | **Opaque tile from the ThumbHash**, no poster blob | the design's recommendation, taken on the user's instruction, 2026-10-09 | none |
| D6 | Ephemeral photos | **None**: a tap sends an ordinary image | same | none |
| D7 | Per-member daily cap | **500 MB per day for `chat-reel`**, from `ownerId`, answered `429` | same | none |
| D8 | "Disclosed report" of a DM/group reel | **Not in v1** | same | none |
| D11 | Expiry display | **Tombstone with the age only**, no "N days left" chip | same | none |

**What the save button changes elsewhere.** Forwarding stays not offered (it copies the `MediaRef`,
so the CEK). A save writes the DECRYPTED video to the gallery through the plugin that already saves a
feed reel: the member's own act on a video they were sent, and the reason nothing here may be sold as
unsaveable. The cache rule of 3.3 (drop the ciphertext at the expiry) is unchanged; a saved copy is
the member's, outside the app.

### 9.2 Still open

| # | Question | State |
| --- | --- | --- |
| D10 | View once for DMs (best-effort), and when | later, after the plain reel message has run for a release; D-view rules it out for now |
| - | The 60 s encode time and real sizes at the decided profile | unmeasured, owed to RC-0 on both phones |
| - | The salon media-download access rule (2.3) | owed to RC-0 |

**Not decided here, deliberately:** live streaming (C9, behind the calls revival); stories (C8:
"not now"); and anything that would make the published reel a conversation attachment.
