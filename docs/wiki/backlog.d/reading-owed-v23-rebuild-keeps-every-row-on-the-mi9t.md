## P1 - Reading owed - a v22 store upgraded on the Mi 9T keeps every message row

target: 1.8.2

Built: the v22 -> v23 rebuild is single-flight, its swap is one guarded transaction, the old table is
set aside and released only once proved, and the history records are bound to the store's incarnation
([local-store-rebuild](../frontend/local-store-rebuild.md)). The reading that closes it: on the Mi 9T,
install a `1.8.0` build (a v22 store), let it hold a few hundred messages, count them
(`SELECT COUNT(*) FROM messages`), upgrade to the fixed `1.8.2` alpha, and read the log - one
`keying N message row(s)`, one `N message row(s) now keyed`, one `the copy of messages is released: N
row(s) set aside, all held`, no `second schema run`, no `REFUSED` - and the same count after. Then
the first connection logs `sweeping every group` (the record names no store yet) and nothing else.

**Read on the iPhone 12, `1.8.2-alpha.8` ([sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha8-iphone-12-the-first-open-of-the-store-fix-tous-in-french-a-picked-photo-and-file)), NOT the reading above (the store was already v23, so no rebuild ran):** the first open over an existing v23 store opens with no `[SQLite]` line, no refusal and no error; a DM's rows are identical before and after (accessibility tree, line for line) and the chat list is unchanged; the first connection runs one history pass (`19/56` groups asked, one left owed with no member online), the next three do not sweep again and ask only that one owed group. **Two gaps:** the line that names the sweep's cause is missing from the pulled in-app ring (a batch seam), so the generation-2 / incarnation attribution is inferred; and the incarnation mint is silent, so it is not read directly. The Mi 9T reading of a real v22 -> v23 upgrade stays owed.
