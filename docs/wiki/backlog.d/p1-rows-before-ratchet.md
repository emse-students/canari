## P1 - rows before ratchet: what is left once a checkpoint stores the buffered rows first (raised by the second review of #3321, 2026-11-15)

target: 1.7.0

**Built (2026-11-17):** a checkpoint stores the rows the live drain's UI buffer holds BEFORE it
exports their ratchet advance, and nothing re-enters the buffer until its write settled
(`BaseMlsService.holdRowsForExport` -> `useMessaging.holdRowsForCheckpoint`;
[chat](../frontend/modules/chat.md#rows-before-ratchet-a-checkpoint-stores-the-buffered-rows-first-2026-11-17)).
That closes the window this entry was raised for - the whole length of a drain's window, seconds on
a catch-up - and its test is the one the entry named: a window still open, a checkpoint's hold, the
"kill" (the window never closes), the rows in the store. The device reading is
[its own entry](reading-owed-rows-before-ratchet.md).

**Left, in order (same class, narrower windows):**

1. **A frame decrypted whose handler has not reached `addMessageToChat` yet** when the export is
   taken (web: an `await` inside the handler between the decrypt and the add; native: a decrypt
   command already issued). The live path outside any drain has the same gap. Milliseconds long,
   but the charter does not count in milliseconds. Closing it means the hold also waits for the
   in-flight application frame's row - without waiting on a handler that may itself await a
   checkpoint (a commit's structural one), which is the deadlock the built step avoids by design.
   The likely shape: the pipeline marks "row owed" at the decrypt of an APPLICATION frame and
   settles it where the row is decided (stored, buffered-then-stored, or no row), and the hold waits
   only for marks whose frames carry no commit. **Size: 2-3 days**, MLS pipeline, Opus review.
2. **The orphan buffer** (`bufferOrphan`): a message whose conversation is not yet in the map is
   kept in memory until `drainOrphanMessages`, so a checkpoint can hold its advance first. Store the
   orphan's row at buffering (the replay then meets it as stored, `storedBodyVerdict`), or include
   it in the hold. **Size: 1 day.**
