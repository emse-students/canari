### Fixed - a deleted salon message's client-id tombstone is kept 30 days, and never outlives its author's account erasure

A daily purge drops tombstones 30 days after the delete (decision 2026-10-18), and a message delete racing an account erasure now waits for it and writes none ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17)).
