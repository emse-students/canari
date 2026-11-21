## Reading owed - the "messages en attente" nudge leaves the shade when its reply is delivered (Mi 9T)

target: 1.7.3

**What is built.** The nudge ("Vous avez peut-etre des messages en attente") follows the outbox
mirror: every native drain settles it under `OUTBOX_LOCK` and withdraws it when the mirror is empty,
and it has its own fixed id (`FixedNotifIds.OUTBOX_NUDGE` = 999), no longer the background worker's
9998. Seen on the Mi 9T, 2026-11-21: the reply was delivered and the nudge stayed until the app
opened. Mechanism: [mobile](../frontend/mobile.md#the-outbox-nudge).

**The reading that closes it**, on the Mi 9T, a `1.7.3` pre-release carrying the change. The nudge is
posted by a drain that FAILS with sends left: a push-woken drain, or the retry worker after its last
attempt - and the worker runs only with a network (`NetworkType.CONNECTED`). Airplane mode therefore
cannot produce it: no push arrives and the worker never runs. Break the network for Canari only: a
private DNS that does not resolve, Wi-Fi up, so the FCM socket stays open and pushes still wake the app.

1. Private DNS broken, answer a message from the shade (quick reply), app closed: the reply's line
   reads "not sent yet". Have a peer send a message, so a push-woken drain fails: the nudge goes up
   under id 999 on `canari_messages_v2` with `AUTO_CANCEL`, and logcat (`CanariFCM`) reads
   `outbox nudge posted (id=999, queued=1)`.
2. Private DNS restored, the app still closed (process dead). Once a push or the worker delivers the
   reply, the nudge leaves the shade WITHOUT the app being opened, logcat reads
   `outbox mirror empty - nudge withdrawn (id=999)`, and the peer receives the reply.
3. A quick reply sent ONLINE logs no "withdrawn" line (no nudge stood).

A nudge posted under 9998 by a build before 1.7.3 needs no reading: the update itself cancels every
notification of the package ([mobile](../frontend/mobile.md#the-outbox-nudge), from AOSP, and
measured below).

**2026-11-21, sitting r173a3 (`1.7.3-alpha.2`, versionCode 100700302, Mi 9T): rows 1, 2 and 3 READ,
PASS; nothing is left owed, and the entry goes when `1.7.3` ships.**

- Row 1: a quick reply from the shade, app closed, private DNS broken: the nudge up as id 999, on
  `canari_messages_v2`, flag `AUTO_CANCEL`; `outbox nudge posted (id=999, queued=1)`. The steps above
  were first written with airplane mode, which cannot produce the nudge (no push arrives); the
  broken private DNS is the deviation the reading took, and the steps now say so.
- Row 2: DNS restored, process dead: a push-woken drain sent the reply and logged
  `outbox mirror empty - nudge withdrawn (id=999)`; the shade empty, the peer received the reply.
- Row 3 (online quick reply): no "withdrawn" line. A second queued send went out with HTTP 201 within
  a second, with no `handleReply` line before it: the read watermark that a delivered reply sends
  (`replyAnswered` -> `sendReadWatermark`), expected
  ([mobile](../frontend/mobile.md#the-outbox-nudge)).
- The pre-update 9998 row, dropped: a 9998 nudge (`AUTO_CANCEL` only) was up on `1.7.3-alpha.1`, and
  after `adb install -r` of `alpha.2` the shade held NO Canari notification at all - the update
  cleared it, as AOSP's `NotificationManagerService` does on every package update. The legacy guard
  that cancelled it was deleted.
