## P1 - rows before ratchet: the orphan buffer, the last window once a checkpoint stores the buffered rows first (raised by the second review of #3321, 2026-11-15)

target: 1.7.1

**Built.** The first step shipped in `1.7.0` (#3786, [read PASS on the web and the Mi 9T on
2026-11-18](../device-verification.md#the-phone-readings-of-2026-11-18-m1-and-i1-170-alpha11)): a
checkpoint stores the buffered rows before it exports
([chat](../frontend/modules/chat.md#rows-before-ratchet-a-checkpoint-stores-the-buffered-rows-first-2026-11-17)).
The two windows this entry then listed first are closed on 2026-11-19
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)): a
frame between its decrypt and its row is waited for by the checkpoint (`RowsOwedLedger`), a failed
live-path row write is kept and retried by the next hold, and an application frame is acknowledged
only once the window's close stored its row.

**Owed with them, on the `1.7.1` pre-release (a reading, not a build):** a catch-up of a few dozen
messages on the Mi 9T and the web, then a reload - every message present, no `[ACK] ... shown and
not stored` line, `[ROWS_OWED] A checkpoint waits` rare and never followed by a stall of the drain.
**Read in [S13](../device-verification.md#the-readings-of-2026-11-20-s13-171-alpha5-replays-sound-under-15-fps-messages-and-the-iphone) (`1.7.1-alpha.5`), the iPhone 12 and a web seat:** the iPhone killed in the middle of a burst of 12, then relaunched - nine pending messages fetched at boot, all twelve present once and in order, the edit, the delete and the reaction applied; no `[DB] POISON ROW`, `[PENDING] A PARKED MUTATION`, `Rows of applied frames` or `[ROWS_OWED]` line in the iPhone's log ring or in the web seats' consoles. **Read in [S14](../device-verification.md#the-readings-of-2026-11-20-s14-171-alpha6-replays-on-both-phones-messages-on-the-mi-9t-the-reactions-at-two-widths) (`1.7.1-alpha.6`), the Mi 9T:** the app force-stopped between the 7th and 8th of a burst of 14, relaunched - all fourteen once and in order, the edit, the delete and the reaction applied; then 36 messages sent while the phone was offline arrived once each and in order from ONE pending fetch. None of `[DB] POISON ROW`, `[PENDING] A PARKED MUTATION`, `Rows of applied frames`; `[ROWS_OWED] A decrypt waits ...` six times at log level (three for three arrivals in a row, which is more than "rare"), each followed by the arrival. **The readings this entry owed are all taken;** what is left is the orphan buffer below.

**Left (same class, narrowest window): the orphan buffer** (`bufferOrphan`). A message whose
conversation is not in the map is kept in memory until `drainOrphanMessages`, so a checkpoint can
export its advance first. What the 2026-11-19 pass established, so the next one starts from it: a
LIVE application frame cannot reach it through `handleKnownGroup` in the ordinary order - that
handler refuses an absent conversation BEFORE it decrypts (`absent-conversation`, not
acknowledged) - so from a decrypted frame the branch is reached only when the conversation leaves
the map between that check and `addMessageToChat` (a deletion or a purge racing the handler), and
the Welcome's replay inserts its conversation before it replays. Two shapes remain open: store the
row at buffering (the restore and the sidebar would have to learn to ignore a message row whose
conversation row does not exist yet), or count the orphan buffer in the hold. First measure which
callers actually reach it (`[ADD_MSG] conversation ... introuvable` with its source), since a row
for a conversation the reader deleted is one to drop, not to store. **Size: 1 day**, Opus review.
