## P1 - rows before ratchet: what is left once a checkpoint stores the buffered rows first (raised by the second review of #3321, 2026-11-15)

target: 1.7.0

**Built (2026-11-17, #3786):** a checkpoint stores the rows the live drain's UI buffer holds BEFORE
it exports their ratchet advance, and nothing re-enters the buffer until its write settled
(`BaseMlsService.holdRowsForExport` -> `useMessaging.holdRowsForCheckpoint`); a row whose write
failed refuses the checkpoint until a later hold stores it
([chat](../frontend/modules/chat.md#rows-before-ratchet-a-checkpoint-stores-the-buffered-rows-first-2026-11-17)).
That closes the window this entry was raised for - the whole length of a drain's window, seconds on
a catch-up. The device reading is [its own entry](reading-owed-rows-before-ratchet.md).

**Accepted, stated:** a hung IndexedDB row write holds every checkpoint (the hold never resolves, the
persister's in-flight checkpoint never clears), and a store that keeps refusing the rows refuses
every checkpoint - commits and joins included (`externalJoin` awaits one) - until a write lands or
the page reloads, said once per page. No timeout: exporting past an unstored row is the loss itself.

**Left, in order (same class, narrower windows):**

1. **A row not yet STORED when the export is taken**: a frame decrypted whose handler has not reached
   `addMessageToChat` (web: an `await` between the decrypt and the add; native: a decrypt command
   already issued), AND a live-path write still in flight - the drain's live path and the ordinary
   one outside any drain alike. Milliseconds long, but the charter does not count in milliseconds.
   The likely shape: the pipeline marks "row owed" at the decrypt of an APPLICATION frame and settles
   it at the WRITE of its row (or where no row is decided), and the hold waits only for marks whose
   frames carry no commit - never on a handler that may itself await a checkpoint (a commit's
   structural one), the deadlock the built step avoids by design. **Size: 2-3 days**, MLS pipeline,
   Opus review.
2. **An application frame acknowledged before its row is stored.** A leader tab acknowledges an
   application frame at the drain's end (`needsDisk` is `structural || refusesCommitsHere()`), and
   `announceAck` runs in `onDrainEnd` BEFORE `endBulkIngest` stores the window's rows: a kill between
   the two leaves the row nowhere on the device and the frame gone from the server. The backstop is
   the history archive - the replay reads the frame again, since no landed checkpoint marked it seen
   - so it is recovered, but by the archive rather than by order. Closing it: acknowledge an
   application frame only once its row is stored (the ack chain waits on the close's store as it
   waits on a checkpoint). **Size: 1 day.**
3. **The orphan buffer** (`bufferOrphan`): a message whose conversation is not yet in the map is
   kept in memory until `drainOrphanMessages`, so a checkpoint can hold its advance first. Not
   closed by #3786: storing the row at buffering writes a message for a conversation the store does
   not hold yet, which the restore and the sidebar would have to learn to ignore. Store it at
   buffering behind that rule, or include it in the hold. **Size: 1 day.**
