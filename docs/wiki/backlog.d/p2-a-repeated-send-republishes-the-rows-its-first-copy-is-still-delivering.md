## P2 - Reading owed - a Welcome sent again is published once

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

**Built (2026-11-25):** a re-send of the same Welcome no longer publishes its still-queued row a
second time. The delivery claims the row in the transaction that publishes it (`deliveryRan`,
migration 058), so a second delivery waits for the first and then only re-arms the deferred push
([mls-protocol](../protocols/mls-protocol.md), "...and delivered once"). The defect was seen on a new
web device (prod `1.7.3`, 2026-11-24): one Welcome row arrived live twice, 160 ms apart. The server
log of that day was gone before it was read, so the trigger (the `[WELCOME] DUPLICATE` path, NOT the
named-frame repeat this entry first blamed) is established from the code.

**The reading that closes it**, on production after the stable that carries migration 058: a
`[WELCOME] ... DELIVERY_ALREADY_RAN` line on chat-delivery confirms the re-send path is real and now
publishes nothing. On a device enrolled after that stable, no `[QUEUE] ... arrived twice - THE SERVER
PUBLISHED THE SAME ROW TWICE` line for a Welcome. A `DELIVERY_ALREADY_RAN` count is enough: read-only
`docker logs ... | grep -c DELIVERY_ALREADY_RAN`.
