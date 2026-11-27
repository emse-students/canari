## P2 - the universal search's message index, kept SEALED between openings if the phone measures its rebuild too slow

target: 1.8.4

**The measured case.** The local message index ([design](../frontend/universal-search.md#the-local-message-index))
is rebuilt at every opening of the search by decrypting every stored message: **6.5 s for 50,000
messages on a desktop** (2026-11-26), one AES-GCM per message, paid in the background - the names and
the other sections answer during it, and the message matches arrive as it fills (review of
2026-11-27). The Mi 9T figure is not taken; it is the reading of [the entry](universal-search.md)
(`[SEARCH] local index: N/N conversation(s) read (W whole) in T ms` in the in-app log). This entry is
worth building only if that figure is too long to bear on a large store.

**Why not SQLite FTS5.** The store is not encrypted as a whole: each message row is sealed by the app
under the device key, beside clear columns (`db/types.ts`, `EncryptedMessageRow`; no SQLCipher). An
FTS5 table would hold every word in clear in that file and undo the seal (charter principle 1). The
evidence is on [the design](../frontend/universal-search.md#why-in-memory-and-not-on-disk-the-evidence).

**The proposed index.** Persist what the index holds, SEALED like every other row: one AES-GCM blob per
conversation (its messages' ids, times, senders and folded text) under the device key, in a new
`SealedStore` so a device-key change re-seals it with the rest (`swapSealedPayloads`). An opening
decrypts one blob per conversation instead of one row per message. It stays true through the
existing seam (`db/messageWrites.ts`): a write names its rows, the snapshot of that conversation is
patched and re-sealed; `'all'` (clear, retention, re-seal) drops every snapshot. What must be decided
when it is built: the snapshot's own version (a store whose snapshot predates a write made by another
web tab must not be trusted - the store's `messageStoreIncarnation` or a per-conversation row count
is the witness, never a clock), and that it is erased with the account's local data at a wipe.

**Passes when** the Mi 9T reopens the search over the same store with the first pass at most the cost
of one decrypt per conversation, the snapshot is unreadable without the device key, and a message
deleted while the search was closed is never found.
