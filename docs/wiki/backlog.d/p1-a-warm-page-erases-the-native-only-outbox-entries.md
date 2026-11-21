## P1 - a warm page erases the outbox entries only the native side holds, an unsendable one included

target: 1.7.3

**The loss.** `outbox_pending.ndjson` has two writers and no owner. The native side appends to it
(`enqueueOutboxMirror`, a quick reply sent from the shade) and rewrites it (the drain, which since
#3928 also keeps the entries it marked `unsendable`), under the Kotlin `OUTBOX_LOCK`. The page
rewrites it WHOLE from its own queue (`syncOutboxMirror` -> Rust `store_outbox_mirror`,
`commands/push.rs`), under no lock the native writes take, and it adopts the entries it does not
know only at a login (`adoptOrphanedMirrorEntries`, `sessionAuth.ts`). So any line the native side
wrote while the page was alive is erased by the page's next outbox mutation - silently, with no log
on either side. Reachable on `main` today; confirmed by the re-review of #3928 (observation 5).

**The scenario.** The app is warm in the background (the WebView alive, the foreground guard
released). A quick reply from the shade takes the native route and is appended to the mirror; the
send fails (offline, a 5xx) or is refused for good and marked `unsendable`. The member opens the app:
a warm resume, no login, so nothing adopts the line. The first message they send, or any outbox
change, rewrites the mirror from the page's queue, and the reply is gone - neither sent, nor shown
failed, nor retried. Principle 2 ([principes](../../principes.md)): the essential is never lost.

**The fix direction - mirror ownership, no clock.**

- The page's rewrite does not replace lines it does not own: it merges, keeping every native-only
  line, under the SAME lock the native writes take (the Rust side takes it through JNI, or the file
  gets one lock both sides use - the native `OUTBOX_LOCK` order stays: `AwaitedReplies` and
  `RingSequencer.lock` under it, `READ_ELSEWHERE.lock` never under it).
- Adoption runs on the return to the front (`canari:foreground`, the warm resume path) as well as
  at login, through the same `adoptMirrorEntry`, logged; an adopted line is then the page's, and its
  next rewrite carries it.
- An adopted entry also enters the in-memory outbox and wakes the flusher, so a NOT_YET entry is
  sent and an `unsendable` one is shown failed with its Retry without waiting for a restart.

**The closing test.** A native-only line (an `unsendable` one and a sendable one), then a page
rewrite of the mirror from a queue that does not hold them: both lines are still in the file, or
both were adopted into the page's queue first - never neither. Plus the warm-resume adoption, with
its log line, in `outboxMirror.adopt.test.ts`. The mechanism is in
[mobile](../frontend/mobile.md#the-retry-ends-on-durable-state-never-on-a-count-173).
