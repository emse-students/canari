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
   ONE line, `handReplyToPage: route PAGE, the foreground guard holds - reply id=... handed over, the
   page told`, the in-app log reads
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
   `unclaimedHandedQuickReplies: 1 reply(ies) a page life took and never settled`, and the in-app log
   `[QuickReply] session ready: reply ... is held by the page (pending)` when the reply was queued -
   the banner then answered, never `réécrivez-le` - or `... the page holds nothing of it - LOST` only
   when it was neither sent nor queued, the banner then `non envoyé, réécrivez-le`. Never `envoi en
   cours` for good. Then the same, signing OUT instead of killing: the in-app log reads
   `[QuickReply] sign-out: the account's unsettled replies are settled`.

**Readings of 2026-11-21 on `1.7.3-alpha.3` (Mi 9T, dev, `dev.0d2bc4b`): rows 1, 2, 3 and 5 OWED, row 4 PASS.**
The precondition of rows 1-3 and 5 - a banner on screen while the app is in front - could not be
produced on this build, three ways tried: (a) with the app in front the push is never shown
(`[PUSH_SHOW] outcome=suppressed-foreground-guard`, also with the page's socket cut by Wi-Fi off for
75 s); (b) a banner posted while the app was in the background is REMOVED within one second of the
app coming to the front (`am start`, polled each second: gone at t+1 s), with the network up or
with a failing private DNS, and **no Canari log line says why** (a silent dismissal - the
2026-11-20 `Every swallowed branch logs` rule); (c) a force-stop clears them anyway. The route
`PAGE` (`handReplyToPage`) was therefore never reached, and nothing of rows 1, 2, 3 or 5 was
read. What is left to try: a banner and the front edge racing (the push landing between the
activity's start and the guard being held), which no sitting here could time.
- **Row 4 (control, background) PASS:** `CanariNotifAction: handleReply: route NATIVE, the foreground
  guard is released`, `handleReply: queued id=...`, `drainOutboxBackground: sent id=...` (HTTP 201),
  the banner kept with the answer (`answerReplyNotification: answered - KEPT_UNTIL_READ`); the
  peer's pane holds the reply.
