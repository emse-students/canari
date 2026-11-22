## P3 - what the production log read of the `1.7.0` stable day left unexplained or noisy (2026-11-18)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Four kinds of WARN in the first 50 minutes of production on `1.7.0` that no wiki page or backlog entry
owns. Each is either expected and should not be a WARN, or the end of something upstream; the reading
that found them is in
[device-verification](../device-verification.md#the-production-reading-of-2026-11-18-the-170-stable-deploy).

1. **social-service's push to chat-delivery timed out once, and its WARN is split in two lines.**
   `[PushService] [PUSH] notify failed for user=<id>` then a second line whose CONTEXT is the error
   (`[DOMException [TimeoutError]: The operation timed out.]`): `push.service.ts` passes the error as
   Nest's second argument, which Nest reads as the context name. The fix of the line is to put the
   error in the message; the timeout itself (`AbortSignal.timeout(DELIVERY_TIMEOUT_MS)`) lost one
   notification and the line does not say which side was slow.
2. **chat-gateway: `[presence] ... sent a N-byte frame after its disconnect - its client stayed (a
   cancelled unload?)`**, 3 times from 3 different web devices in 45 minutes. The mechanism (#3509)
   is right to end the socket, but the cause it names is a guess; at that rate a cancelled "leave this
   page?" prompt is unlikely, and the web client should be read for another path that sends
   `disconnect` and keeps the document.
3. **core-service: `CORS DENIED origin "null"`**, once. [nginx](../infrastructure/nginx.md) explains how
   a `no-referrer` page makes a non-GET carry `Origin: null` and says WebKit and Firefox were never
   measured - this is probably that, and nothing owns it.
4. **social-service: `[NOTIFY] association <id> pushes no picture, not its logo - logoMediaId=absent`**,
   4 times (#3770). An association with no logo is an ordinary state, not a defect; only
   `present but refused` accuses something. As written it repeats on every push of such an
   association.
