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
