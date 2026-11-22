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

**Readings of 2026-11-21 on `1.7.3-alpha.3` (Mi 9T, dev): row 2 PASS, row 3 PARTIAL, row 4 PARTIAL, row 1 OWED.**
- **A blocker for rows 1 and 3's first half, found by reading:** the reading's way of producing an
  outage - a private DNS that does not resolve - leaves the network UNVALIDATED, and
  `OutboxRetryWorker` requires `INTERNET&TRUSTED&VALIDATED`, so the system never runs it
  (`dumpsys jobscheduler`: `Unsatisfied constraints: CONNECTIVITY`; no `doWork` line in 11 minutes,
  from 18:15 to 18:26). No run exists to say `still queued, each can still go - retry`. The reading
  needs an outage that keeps the network validated (a backend that answers 5xx or does not answer
  while the internet is up); the DNS recipe cannot produce one.
- **Row 2 PASS:** private DNS restored after 12 minutes: `doWork: drain run 0 (1 queued)`,
  `sendQueuedMessagePush: HTTP 201`, `drainOutboxBackground: sent`, `doWork: outbox drained - success`
  (the next job run after the network validated, 2 s after the setting changed).
- **Row 3 PARTIAL:** at the background edge `enqueueIfMirrorHolds: 1 queued as the app leaves the
  front - retry enqueued` and the reply left on that run (`outbox drained - success`, about 2 minutes
  later, when the DNS was restored). NOT READ: the in-front line `the outbox is the page's, this
  request ends` (the worker never ran in front, same blocker).
- **Row 4 PARTIAL:** two replies queued (a DM and a group the account had been removed from), DNS
  restored: the DM left (HTTP 201); the other `sendQueuedMessagePush: HTTP 403 is a refusal of this
  frame - kept, and no background retry will send it`, `1 message(s) will not go from here - kept,
  marked, the member told`, the nudge posted (`id=999, queued=1`), `doWork: 1 message(s) left, none
  can go from here - marked and told, the request ends`. NOT READ: the runs that follow a refusal
  while another entry can still go (the DM left in the same run), and "Réessayer" in the app: the
  refused entry's conversation was a removed one ("Cette conversation a été supprimée", no composer),
  where no failed line or Réessayer showed after opening the app, and the nudge was gone. A refused
  reply in a conversation that still exists was not produced.

**Mi 9T sitting, 1.7.3-alpha.5 (2026-11-22): PARTIAL, entry stays. A Canari-only network block (not private DNS, which blocks the worker entirely) held one queued message; on unblock the worker ran, drained it and ended SUCCESS (one failed-then-success cycle, logcat CanariOutboxRetry/CanariFCM). UNREAD: more than one failed worker run before success.**
