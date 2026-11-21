## P2 - an inline reply sent with the app in front sits queued until the app is backgrounded

target: 1.7.3

Seen on the Mi 9T during the device reading of #3912 (2026-11-20, dev, Android): a reply typed in a
conversation banner's inline field while the app was IN FRONT stayed queued for about four minutes,
and went out only once the app was backgrounded. Not caused by #3912.

What the native log said, in order:

- `encryptQueuedMessages: ... foreground active - background mls.bin write abandoned` - the native
  side encrypted nothing, leaving the MLS state to the foreground;
- `OutboxRetryWorker: ... outbox handled by TS, retry deferred (not an attempt)` - the retry worker
  stood down for the WebView;
- the WebView never sent it: nothing in the TS outbox drained the entry while the app stayed in front.

So the hand-off between the native outbox (`outbox_pending.ndjson`, the [outbox
mirror](../frontend/mobile.md#outbox-mirror)) and the WebView's has a hole: each side defers to the
other while the app is in front, and nothing tells the WebView an inline reply was queued. After the
send went out, the conversation's banner still said `non envoyé`: the pending-reply line is cleared
only on the native delivered branch, which this send did not take.

What closes it: a native enqueue in the foreground hands the entry to the WebView (or the WebView
drains the mirror on that event), deterministically - no retry timer - and the delivered path that
runs, whichever side sends, clears the banner's pending line. A test: enqueue an inline reply with the
foreground flag set and assert the send is triggered without a background transition.
