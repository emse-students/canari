## P2 - a late write of an incoming seed can raise a floor a repair lowered since

target: 1.9.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

**What is wrong** (read against the code on 2026-11-15, re-read 2026-11-17). `storeIncomingSeed`
(`frontend/src/lib/utils/graine/frameHandler.ts`) moves a held received session's floor by writing
`{ ...existing, firstIndex }` over a row it read earlier, with no condition at the write. A copy
written after a repair lowered the floor since that read puts the higher floor back. It costs
history the missing-seed repair then asks for again, never a key: the write carries no `sentCount`,
so it can never make an index be handed out twice (that door is closed by the reservation's
compare-and-swap, [channel-encryption, WP-30](../protocols/channel-encryption.md#wp-30-and-the-departure-nobody-records)).
A race that heals is still a defect.

**The fix, about half a day.** The same shape as the reservation: the floor write lands only while
the stored row still carries the `firstIndex` it was read at (and a row that gained a `sentCount`
since is not overwritten), checked in the write's own transaction on both backends, with a two-tab
test over one IndexedDB that fails before.
