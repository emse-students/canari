## Reading owed - an inline reply typed over the open app goes out at once (Mi 9T)

target: 1.7.3

**What is built.** Read on the Mi 9T during #3912 (2026-11-20): a reply typed in a banner's inline
field with the app IN FRONT sat queued for about four minutes and left only once the app was
backgrounded, and its banner still said `non envoyé`. The native encrypt was refused by the
foreground guard, `OutboxRetryWorker` stood down for the page, and the page never heard of a mirror
entry it had not written. Now the receiver asks the route first (`QuickReplyRoute`, on the Rust
foreground guard the refusal reads) and hands the reply to the page, as iOS does: one sealed line in
`pending_quick_replies.ndjson`, recorded and drawn `envoi en cours`, then `canari:quick-reply`; the
page sends it through the composer's path and acknowledges it, and only that acknowledgement draws
the banner answered. Mechanism:
[mobile](../frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)
("Android takes the same road").

**The reading that closes it**, on the Mi 9T, a `1.7.3` pre-release carrying the change, online:

1. The app open on another screen than the conversation, a peer sends a message, the banner shows:
   answer from its inline field. Logcat (`CanariNotifAction`) reads
   `handleReply: the foreground guard holds - route PAGE` then
   `handReplyToPage: reply id=... handed to the page in front, told`, the in-app log reads
   `[QuickReply] the native side says a reply waits: 1 native reply(ies) taken`, and the peer receives
   the reply within seconds, the app never leaving the front. No `encryptQueuedMessages` refusal and
   no `OutboxRetryWorker` line for it.
2. The banner: its spinner ends at once on `envoi en cours`, then - on
   `drawHandedSettlement: reply id=... held by the page - answered` - the answer is drawn as the
   user's own line or the banner goes; no `non envoyé` line at any point.
3. The conversation in the app shows the reply once, sent - not twice, and not a second time after
   the app is backgrounded and reopened.
4. Control, the app in the background: a quick reply still goes the native way (`handleReply: queued`,
   `✓ sent`), unchanged.
5. A page that dies holding a reply: answer from the banner, then kill the app from the recents
   before the peer receives it (airplane mode makes the window wide). Reopen and sign in: logcat reads
   `sweepHandedQuickReplies: reply id=... taken by a page that died before sending it - LOST` ONLY if
   the reply was neither sent nor queued - otherwise nothing - and the banner then reads
   `non envoyé, réécrivez-le`, never `envoi en cours` for good.
