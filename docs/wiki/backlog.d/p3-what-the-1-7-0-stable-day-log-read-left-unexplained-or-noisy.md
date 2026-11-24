## P3 - what the production log read of the `1.7.0` stable day left unexplained: two lines remain (2026-11-18)

target: 1.10.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-23: lines 1 and 4 are fixed (PushService puts the error and the budget it ran out of in ONE
message; an association with no logo no longer warns, only `present but refused` does). Lines 2 and 3
stay: each needs a measurement this checkout cannot take._

Two WARN lines from the first 50 minutes of production on `1.7.0` still have no owner. The reading that
found them is in
[device-verification](../device-verification.md#the-production-reading-of-2026-11-18-the-170-stable-deploy).

2. **chat-gateway: `[presence] ... sent a N-byte frame after its disconnect - its client stayed (a
   cancelled unload?)`**, 3 times from 3 different web devices in 45 minutes. The mechanism (#3509)
   is right to end the socket, but the cause it names is a guess; at that rate a cancelled "leave this
   page?" prompt is unlikely, and the web client should be read for another path that sends
   `disconnect` and keeps the document. **Owed: a read of the web client's `disconnect` senders
   against the production log's device ids; the frame's own content (its `type`) is not in the line
   and would say which path it is.**
3. **core-service: `CORS DENIED origin "null"`**, once. [nginx](../infrastructure/nginx.md) explains how
   a `no-referrer` page makes a non-GET carry `Origin: null` and says WebKit and Firefox were never
   measured - this is probably that. **Owed: that measurement on WebKit and Firefox (a POST from the
   `no-referrer` receipt page), or the request's method and path in the line (four copies of
   `cors-origins.ts`) so the next one names its page.**
