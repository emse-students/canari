## Reading owed - the "messages en attente" nudge leaves the shade when its reply is delivered (Mi 9T)

target: 1.7.3

**What is built.** The nudge ("Vous avez peut-etre des messages en attente") follows the outbox
mirror: every native drain settles it under `OUTBOX_LOCK` and withdraws it when the mirror is empty,
and it has its own fixed id (`FixedNotifIds.OUTBOX_NUDGE` = 999), no longer the background worker's
9998. A nudge posted under 9998 before the update is withdrawn only when that record is not the
worker's notice. Seen on the Mi 9T, 2026-11-21: the reply was delivered and the nudge stayed until
the app opened. Mechanism: [mobile](../frontend/mobile.md#the-outbox-nudge).

**The reading that closes it**, on the Mi 9T, a `1.7.3` pre-release carrying the change:

1. Airplane mode on, answer a message from the shade (quick reply): the reply's line reads "not sent
   yet". Leave the app closed until the nudge is up (the worker posts it after its drains fail, or a
   push-woken drain does).
2. Airplane mode off, the app still closed. Once the worker or a push delivers the reply, the nudge
   leaves the shade WITHOUT the app being opened, and logcat (`CanariFCM`) reads
   `outbox mirror empty - nudge withdrawn (id=999)`.
3. If a nudge from the previous build was up across the update, it leaves with the first logged
   withdrawal (`a nudge posted before 1.7.3 withdrawn (id=9998)`), and the worker's foreground notice,
   if ever shown, is never taken down (`is the worker's notice ... - left`).
