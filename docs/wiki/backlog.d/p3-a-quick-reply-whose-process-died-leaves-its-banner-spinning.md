## P3 - a quick reply whose process died before its decision leaves its banner spinning

target: 1.7.3

Residual of #3912 (round-10 review, 2026-11-21, Android). A quick reply from a conversation banner is
decided in the process that received the action: its drain, then either the success (cancel and
watermark) or the re-post as pending, which is what ends the spinner Android draws on the banner
after a `RemoteInput`. Every path of a LIVE process ends in one or the other
([social-service](../services/social-service.md)). A process killed between the enqueue and that
decision ends neither: the banner keeps its spinner and has lost its Reply and Mark-read actions,
until something else re-posts or cancels it. The reply itself is not lost - it stays in
`outbox_pending.ndjson`, which the retry worker or the app drains - and its later delivery finds no
pending line to clear, since none was posted.

What resolving it needs: a fresh process cannot learn from memory which banner is mid-reply, so it
needs a durable fact. Either the handler writes "reply `id` in flight for conversation `g`" before
the enqueue and clears it after the decision, and a fresh process (the drain, or the app's start)
that finds such a record re-posts that banner from the shade - pending if the entry is still queued,
cancelled if `outbox_sent` lists it; or the shade read in a fresh process recognises a banner whose
last post carries the reply action's in-flight state. The first is deterministic and testable on
the JVM; the second depends on what SystemUI keeps of a `RemoteInput` history. Closed by a test that
kills the handler between the enqueue and the decision and asserts the next process ends the spinner.
