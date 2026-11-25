## The media cache has a default cap of 500 MB, with member tiers (owner, 2026-11-22)

target: 1.8.1

The Cache Storage bucket `canari-media-ciphertext-v1` grows without bound. Owner decision of 2026-11-22 ([decisions](../decisions/owner-decisions-of-2026-11-22.md), items 8 and 9): a default cap of **500 MB**, the member choosing 250 MB, 1 GB or unlimited. Eviction is LRU and **never evicts a sole copy**: the server purges ephemeral media after 90 days idle, so an old cached copy may be the only one left. There is **no server re-touch before eviction**. Charter principles 2 and 1 ([principes](../../principes.md)).

To settle when it is picked up: how the device knows a copy is the sole one (what it holds that says the server's copy is gone or purgeable), the settings text in French and English, and a test that fills the cap and checks the order of eviction and that a sole copy stays.
