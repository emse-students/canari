### Fixed - an iPhone no longer counts as reading while it leaves, and a read made just before leaving reaches the other devices at once

The iOS shell now tells the page when the app goes to the background and comes back, as Android does, and the last read before leaving is sent under a background task instead of waiting for the next open ([chat](docs/wiki/frontend/modules/chat.md#read-state-between-devices---the-census-2026-11-02)).
