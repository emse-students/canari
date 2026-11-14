## P3 - Device-local rows written as `system` are relayed into other members' timelines (review of #2412, 2026-10-25)

target: 1.9.0

The acting device now writes its own visible notice under the frame's id
([history-reconciliation](../protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice)).
Left, not built: rows that only THIS device should ever hold are written with the same sentinel
sender and a random id - the outbox's edge-blocked and send-failure lines (`outbox.ts`), the eviction
notice (`eviction.ts`) - so they enter this device's digest, the diff pushes them to every peer that
lacks them, and they land in other members' timelines marked unverified. The rule wanted is a
property of the row ("device-local": never described, never relayed), carried at the write rather
than guessed from the sender. Found by reading; the relay count in the field is unmeasured.

**The device notice's contact line is the same class, with one difference (DEV-1, `1.4.1-alpha.3`,
2026-10-25).** `writeContactLines` (`deviceNotices.svelte.ts`) writes the "X added a device" line with
the same `system` sender, under a DETERMINISTIC id (`contactLineId(group, event)`), so two contacts
that both wrote it never trade it. But the device's OWNER never writes it (`owner-alert`, no line),
nor does a device minted after the event - so the digest diff can push a contact's line to exactly
those devices, unverified. The DEV-1 judge reads the owner's pane at 0 lines within the row, which
bounds the window, not the relay. **The fresh device RECEIVED them.** On DEV-1, W3's `[AUTHORSHIP] N
restored message(s) ... relayed by <user> carry no author proof` lines name W2's account as the relayer
of exactly 1 unverified row in the group the row had just created. That is the one line DEV-1's judge
counts there, the line about W3 itself. Each contact relays 3 to 5 such rows per standing conversation,
in step with the owner devices minted before. This was read from relay counts by relayer, not row by
row. The same "device-local" property closes both.

Re-read 2026-11-11 (batch 12): still real - no "device-local" property exists on a row; the outbox, eviction and contact lines still use the `system` sender. Re-read again 2026-12-11.
