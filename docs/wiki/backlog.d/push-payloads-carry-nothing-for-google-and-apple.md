## P2 - push payloads carry nothing for Google and Apple (decided to record 2026-11-01, not built)

Recorded from the owner's sovereignty philosophy ([durable-rules](../durable-rules.md#product-philosophy---sovereignty)).

- **Today** FCM and APNs see the sender and group names, a social excerpt, and the caller's name on an Android call ring; the message content is already E2E. Source: [register-of-processing](../compliance/register-of-processing.md) section 8.
- **Goal**: a content-free wake-up push. The device fetches the rest from our server and decrypts it locally, as Signal does. Google and Apple then learn only "this device got a notification at this time".
- **Costs**: one more network round trip per notification, and the iOS NSE time budget (around 30 s), which overlaps queue item 1 (iOS notifications show no content).
- **APNs cannot be replaced on iOS**: only Apple can wake an iOS app.
- **Android options beyond FCM**: UnifiedPush with a self-hosted distributor such as ntfy (needs an install on the DSI host, so their written agreement; users must install a distributor app, so FCM stays the default), or a persistent connection (battery cost, OEM killing).
- **Once built**, update the register and the privacy policy together.
