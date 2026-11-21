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

A second window of the same worker, named here deliberately (round-12 review, S-d). The unique
work is `APPEND_OR_REPLACE`, and a run that finds the app in front returns `Result.retry()` without
counting an attempt: the outbox belongs to the app while it is visible. Each such deferral still
grows WorkManager's exponential backoff, and a request appended behind the chain waits for the run
ahead of it to end. So a reply queued after a long foreground session can wait for hours. Ending
the chain when the app comes to the front (`cancelUniqueWork`) is NOT provably safe today. Once the
app has adopted the mirror, nothing native enqueues a retry when it goes back to the background, so
an entry the app had not sent by then would lose its only background retry until the next push. The
durable-state design above closes both: a deferral that is not an attempt ends the request
(`Result.success()`), and the app's move to the background enqueues a fresh retry whenever the mirror
still holds an entry. Closed by a test that defers three times in front and then, in the background,
runs the drain without waiting out a grown backoff.
