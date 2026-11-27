## P2 - iOS: a quick reply from a suspended app is not sent in the background time, it waits for the next open

target: 1.8.4

**Read 2026-11-15 on dev (iPhone 12, TestFlight `1.6.12-alpha.2`, build `100601202`), 1 of 1 - the iOS
twin of check K.** The app left on the home screen about 12 s, a DM from the delta web seat, the card
held, "Répondre", a line typed and "Envoyer": `handleQuickReplyAction: the page holds the MLS state -
reply handed to it, the response held until it is settled`, then 25.9 s later `ERROR quick reply:
iOS ended the background time before the page settled it - read as still pending`, the pending-sync
notice ("Vous avez peut-être des messages en attente, ouvrez l'application pour les envoyer.") and
`BGTask outboxRetry scheduled`. The peer received nothing until the app was opened by hand, when the
reply went out at once.

[mobile](../frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)
says "A SUSPENDED PAGE GETS THE TIME TO SEND THE REPLY": the background task is begun, but the page
did not settle in the whole of it, so either the WebView's script stays suspended under the task or
the page's outbox waits on something that a suspended app cannot reach (its socket). Nothing is lost
- the fallback said so and the open sent it - but the fallback IS the path here. **Next:** the page's
`[OUTBOX]`/quick-reply lines over the same 26 s on a build whose WebView is inspectable, to tell the
two causes apart, then fix where the page stalls.
