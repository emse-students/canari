## P2 - the "messages en attente" nudge stays in the shade after its reply was delivered

target: 1.7.3

**Seen on the Mi 9T, 2026-11-21.** A quick reply was queued, the nudge (`PENDING_SYNC_NOTIF_ID`,
`FixedNotifIds.PENDING_SYNC` = 9998: *"Vous avez peut-être des messages en attente, ouvrez
l'application pour les envoyer"*) went up, and `OutboxRetryWorker` (`canari_outbox_retry`) then
delivered the reply. The nudge stayed in the shade until the app was opened.

**Why.** Every drain that leaves sends queued shows the nudge (`maybeNotifyPendingSync`,
`OutboxRetryWorker` -> `showPendingSyncNotification`), but no path removes it when the queue empties.
`drainOutboxBackground` already clears each delivered reply's own "not sent yet" line
(`replyDelivered`); the nudge has no counterpart. Only the app's launch clears the shade.

**The change.** The nudge goes when the outbox mirror empties: after `drainOutboxBackground` releases
`OUTBOX_LOCK` with nothing remaining, cancel `PENDING_SYNC_NOTIF_ID` (idempotent when it is not up),
whichever caller drained - the worker, a push-woken drain, the boot drain, the quick reply's first try.
A drain that still leaves sends keeps it. The nudge states a fact about the queue, so the queue's
own state removes it: no timer, no "was it shown" flag.

**Test.** A source pin that `drainOutboxBackground` cancels the nudge when `remaining == 0`, outside
the outbox lock. And a reading on the Mi 9T: queue a reply offline, let the worker deliver it, and
see the nudge leave without opening the app.
