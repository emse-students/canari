## Reading owed - `STALE_EPOCH_FRAME` per app build over a week

target: 1.7.0

**Re-read 2026-11-11.** Four senders' devices sealed seed requests at epochs 135-138 while the key group was at 141; no current member can open them (`max_past_epochs` 2), and each loss drives a re-ask. The drain order was REFUTED as the cause ([channel-encryption §23](../protocols/channel-encryption.md#not-the-cause-the-drain-order)). **The measurement is built and on `main`**: chat-delivery logs `STALE_EPOCH_FRAME` with the group, the distance, the sender's device and `app=` build for every such frame (`messaging.service.ts`, `messaging.send-race.spec.ts`), REPORTED and never refused. **Owed, and readable now from production's delivery log (not read here):** the count of `STALE_EPOCH_FRAME` lines per `app=` over a week. If the lagging builds are all below the floor, the floor closes this; if current builds still lag, decide the `stale_epoch` refusal (the sender catches up and re-seals) with that count.
