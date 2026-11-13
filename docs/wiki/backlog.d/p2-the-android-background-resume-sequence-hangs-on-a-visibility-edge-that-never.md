## P2 - the Android background/resume sequence hangs on a visibility edge that never fires (owed ONE device run)

target: 1.10.0

`handleVisibilityChange`, the `mls_foreground_heartbeat` interval and the resume reload must move
TOGETHER onto the native edge, after one Mi 9T run (background past the 30 s guard, send, return, read
whether the background engine delivered, the warm engine reloaded and the socket paused)
([the three pieces](../protocols/campaign-measured-defects.md#the-android-backgroundresume-sequence-2026-09)).

_Context, from the former backlog section "MLS state, device healing and delivery - the defects the campaign measured":_ Open entries only; each carries a title, what is left and a link. The measurements, recurrences and
refuted readings are on [campaign-measured-defects](../protocols/campaign-measured-defects.md), the
cold-start ledger on [history-reconciliation](../protocols/history-reconciliation.md).
