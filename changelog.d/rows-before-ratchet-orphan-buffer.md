### Fixed - a checkpoint no longer exports past a decrypted message held for an absent conversation

The last window of "rows before ratchet": a decrypted message whose conversation had left the map is
now stored or dropped by the checkpoint's hold before the export, and its frame's ack waits for it; a
row a store is retrying or replaying stays counted until its write lands, and a backup import no
longer empties the conversation list
([chat](docs/wiki/frontend/modules/chat.md#rows-before-ratchet-the-orphan-buffer-2026-11-20)).
