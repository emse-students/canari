## P1 - a backup restore resumed an outbound Graine session at an index it had already used

target: 1.7.0

**What was wrong.** The backup carried each Graine session's `sentCount` and the import wrote it
back. After a wipe, with the MLS state restored from the same file, the key group's run still
matched the session's rotation anchor, so the next salon send reused the session at the count of the
export: every index sealed between the export and the wipe was handed out again. The server refuses
a second row under one `(senderSessionId, messageIndex)` (409 `CHANNEL_MESSAGE_KEY_REUSED`), so
those sends failed; every seal draws a fresh random nonce, so no AES-GCM nonce was repeated.

**What is built** (branch `fix/graine-restore-forces-new-run`): the file carries no `sentCount` and
the import writes none, so a restored session is one the device reads and the first send mints a new
one. Pinned by `frontend/src/lib/backup.graineRestore.test.ts`. The mechanism is in
[backup](../frontend/backup.md#a-seed-comes-back-to-read-never-to-seal-under---2026-11-15).

**Owed before this entry is deleted:** the fix shipped in `1.7.0`.

**Two neighbouring findings, read against the code on 2026-11-15** (both belong to the leader-only
write of #2515, `mayWrite`, still a draft):

- `storeIncomingSeed` writes without `mayWrite`. It never writes a `sentCount` (it returns early on a
  held session that has one, and a new or received row carries none), so a late write from a tab that
  lost the lead can only turn this device's outbound session into a received one, and the next send
  then mints: no index is handed out twice. It can raise a received session's floor back above one
  a repair lowered since (it writes over a row it read before that repair), which costs history the
  missing-seed repair asks for again, never a key.
- The reservation's write is guarded by leadership read at the write, not by the count it read: a
  tab that still believes it leads between a lock steal and the rejection that tells it can write a
  count the new leader has already advanced past. The proof would be a compare-and-swap on
  `sentCount` in the write's own transaction (write `n + 1` only while the row still says `n`),
  which closes it whatever the leadership says. To be decided with #2515.
