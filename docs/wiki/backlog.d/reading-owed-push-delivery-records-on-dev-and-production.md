## Reading owed - the push delivery records count and stamp on dev, then on production

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Built (owner, 2026-11-21: "totals + last delivery"): migration `054` adds `push_delivery_daily` and
`push_token."lastPushSentAt"` / `"lastPushFetchedAt"`, written once per send batch and on every push
fetch ([chat-delivery](../services/chat-delivery.md#push-delivery-records---daily-totals-and-the-last-delivery-per-device-2026-11-21)).
The reading that closes it: after the pre-release serves dev, one message to a shut bench phone, then
the two documented queries show `message/<platform>/attempted` and `accepted` for the day, that
phone's `last_sent` after the send and - on a wake-capable build - its `last_fetched` after it, and
no `[PUSH_RECORD]` WARN in the chat-delivery log; the same queries read on production a day after the
stable, the totals agreeing in order of magnitude with that day's `[PUSH_SEND]` / `[SOCIAL_PUSH]`
lines.
