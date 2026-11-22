## Reading owed - a warm page keeps, and adopts, a reply queued from the shade (Mi 9T)

target: 1.7.3

**What is built.** The outbox mirror (`outbox_pending.ndjson`) has two writers. The page used to
rewrite it whole from its own queue, under no lock the native writers take, and adopted the lines it
did not know only at a login, so a reply queued from the shade while the app was warm in the
background was erased by the page's next outbox mutation: neither sent, nor shown failed, nor
retried. Each line now says whose it is (`owner: "page"`), the page writes only its own under
Kotlin's `OUTBOX_LOCK` (taken from Rust over JNI), and the page adopts the native lines on every
return to the front, puts them on screen and flushes them. Mechanism:
[chat-delivery](../services/chat-delivery.md#the-outbox-mirror-has-two-writers).

**The reading that closes it**, on the Mi 9T, a `1.7.3` pre-release carrying the change:

1. The app warm in the background (opened, then the home button), airplane mode ON: answer a
   message from the shade. Logcat (`CanariFCM`) reads the reply queued, and its send failing.
2. Still in airplane mode, open the app (a warm resume, no PIN) and send a message in ANOTHER
   conversation - the outbox mutation that used to erase the reply. The in-app log reads
   `[OUTBOX] 1 native entry adopted on the return to the front - flushing`, and no
   `adopted but NOT claimed` line. The shade reply shows in its conversation as pending.
3. Airplane mode OFF: both messages leave, each once - the peer receives the shade reply ONE time.
4. An unsendable one: answer from the shade, with the app warm in the background, a conversation
   this device was removed from (the drain marks it `unsendable`). Open the app: the reply is shown
   FAILED with its Retry, at once, without a restart; sending another message does not make it
   disappear.
5. Never `page write NOT done` nor `OUTBOX_LOCK not taken` in logcat across the whole reading.

**Mi 9T, `1.7.3-alpha.6` (2026-11-22): rows 1, 2, 3 and 5 PASS, row 4 NOT readable.** App warm in the background, the app's network denied (`cmd connectivity`, the per-app equivalent of airplane mode): a shade reply failed to send and stayed queued (`stays queued (TRANSPORT_FAILED)`, `re-posted as pending, retry scheduled`). A warm resume and a message to ANOTHER conversation: the in-app log reads `1 orphan mirror entr(y/ies) to adopt`, `1/1 ... adopted`, `1 adopted native entry claimed - pending again, flushing`, `1 native entry adopted on the return to the front`, and no `adopted but NOT claimed`; the shade reply shows in its conversation as pending. Network re-allowed: both left, each once, the peer holding the shade reply ONCE; logcat holds no `page write NOT done` and no `OUTBOX_LOCK not taken`. **Seen on the way, not a row:** an ERROR-level `[OUTBOX] e295f1ab... is queued with no stored message - the send has nothing to show` for an entry that is not this reply (two older entries for other conversations sat in the outbox) - by the noise rule it is either expected (then not an error) or the end of a stale entry, to trace. **Row 4 replacement:** in `outboxMirror.adopt.test.ts`, adopt a native entry with `unsendable: true` and assert the stored row is FAILED with its retry available, and that a following page outbox mutation leaves it in place. The entry stays for row 4.
