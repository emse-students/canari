## Reading owed - a message resent under one `messageId` is stored once

target: 1.7.0

**What is built:** a message resent under one `messageId` is stored once (migration 048, 2026-11-13; unit specs and a PostgreSQL integration spec, [chat-delivery](../services/chat-delivery.md#a-message-sent-twice-under-one-id-is-stored-once-migration-048-2026-11-13))

**The reading that closes it:** on dev, the pre-release carrying it, on the Mi 9T with the app killed: a notification quick reply sent on a link slowed past the 10 s read timeout (or with the answer held), then the next drain - the receiver shows ONE message, chat-delivery logs one `REPEATED_MESSAGE_ID` naming that group with the gap, and the sender's `outbox_pending.ndjson` no longer holds the entry; then, a week after the stable, the production count of `REPEATED_MESSAGE_ID` lines per day (the rate of lost answers the 10 s timeout causes)
