## Reading owed - the background outbox retry outlives a backend outage, and leaves the front to the app (Mi 9T)

target: 1.7.3

**What is built.** `OutboxRetryWorker` used to give up after three failed drains - about three and a
half minutes of backoff - so a backend down that long while the phone was online left a quick reply
waiting for the app to open (#3912 review, round 11). Now the drain says why each entry remains
(`OutboxRetry.Prospect`, classified where each failure is thrown, the native batch included) and
the worker retries with no cap while any can still go. An entry that never will (a 4xx refusal, a
group not held) is marked, skipped, told by the nudge and adopted failed by the page; only a device
that can send nothing (no push secret, no MLS state, a key that does not open it) or an unreadable
push context ends the retry. A run
with the app in front ends its request, and the move to the background enqueues a fresh one when
the mirror holds an entry. Mechanism:
[mobile](../frontend/mobile.md#the-retry-ends-on-durable-state-never-on-a-count-173).

**The reading that closes it**, on the Mi 9T, a `1.7.3` pre-release carrying the change:

1. App closed, Wi-Fi up, a private DNS that does not resolve (as in the nudge reading): answer a
   message from the shade. Leave it ten minutes or more. Logcat (`CanariOutboxRetry`) reads
   `still queued, each can still go - retry` on each run, never `the app must open`; no failure flag.
2. Private DNS restored, the app still closed: the next worker run (or a push) sends the reply, the
   peer receives it, `outbox drained - success`.
3. Back pressure in front: queue a reply offline from the shade, open the app and stay in it a few
   minutes, then background it. Logcat reads `the outbox is the page's, this request ends` while in
   front, then `enqueueIfMirrorHolds: ... retry enqueued` at the background edge if the page had not
   sent it - and the reply leaves on that run, not hours later.
4. A refused entry beside one that can go: with the private DNS off, answer conversation A from the
   shade, then make the backend refuse a second reply (answer from the shade a conversation this
   device was removed from). Logcat reads `marked unsendable` (or `refusal of this frame`) and
   `will not go from here - kept, marked, the member told`, the nudge shows, and the runs that follow
   read `can still go - retry` - never `the app must open`. DNS restored, A's reply leaves; opening the
   app shows the refused reply failed, with "Réessayer".
