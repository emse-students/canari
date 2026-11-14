## Reading owed - the in-session community join through the deep link on the phones

target: 1.7.0

The fix is built ([chat](../frontend/modules/chat.md#a-community-joined-in-session-is-listed-whole-2026-10-08)): a community new to the device is hydrated by the full listing. **The web half passed on 2026-11-14** (`bun unread-communities.mjs run join` on the local estate at `ad2053fc0`: right after an in-app join the reader's sidebar listed every salon and a message posted after the join raised each salon's badge, before any reload). Owed: one look at a join through the deep link on iOS and on Android, a private salon the joiner may read included.
