## P2 - a DM opened on the iPhone never shows as read on the sender's Mi 9T (observed 2026-11-03, `1.6.3-alpha.7`)

Repro, two dev bench accounts: the Mi 9T account sends a short text to the iPhone account; the iPhone
lists "1 message non lu" and its user opens the conversation; the Mi 9T keeps the single check, with
no reader head and no double check ([chat](../frontend/modules/chat.md), "Read receipts"), for over two minutes and after
leaving and reopening the thread. logcat has no read-mark line on the Mi 9T. Not yet known: whether
the iPhone never sends the mark, the server drops it, or the Android side never draws it. Owed: the
iPhone device log at the open, then the reverse direction (iPhone sends, Mi 9T reads) to split the
causes. Reading: [device-verification](../device-verification.md).
