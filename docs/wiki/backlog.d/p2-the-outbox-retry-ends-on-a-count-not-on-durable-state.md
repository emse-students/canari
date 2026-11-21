## P2 - the background outbox retry ends on a count, not on durable state

target: 1.7.3

Found in the #3912 review (round 11, 2026-11-21, Android). `OutboxRetryWorker` gives up after
`MAX_DRAIN_ATTEMPTS` (3) real drains, posts the "open the app" nudge and sets a failure flag that
only opening the app resets. Since #3912 it runs only with a network (`NetworkType.CONNECTED`), so
an offline run is no longer an attempt. The cap itself is still a clock: with exponential backoff
from 30 s, three failures take about three and a half minutes. So a backend that is down for a few
minutes while the phone is online spends every attempt. After that, a reply queued in the outbox
waits for the user to open the app, which principle 2 (the essential is never lost) does not accept.

Why a count is wrong here. It answers "how long have we tried", and the decision needs "can a
retry ever succeed". A transport failure (no answer: DNS, connect, timeout) and a 5xx say "not
yet", and a later retry can succeed. A 4xx refusal of the frame says "never", and no retry will
change that. The drain already classifies each POST (`sendQueuedMessagePush`), but it returns only
a count of what remains.

What closing it needs: the drain returns WHY each entry remains, as a type. The worker retries, with
no cap, while every remaining entry is "not yet" (WorkManager's backoff already bounds the cost,
up to five hours between runs). It ends, and nudges, only on a "never" entry or an unreadable push
context, which is durable state saying the retry cannot succeed. Closed by a JVM test: three
transport failures in a row still end in `retry`, and one 4xx ends in the nudge.
