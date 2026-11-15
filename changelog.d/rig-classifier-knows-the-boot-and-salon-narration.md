### Fixed - the cross-client rig no longer reports PASS-DIRTY on a healthy boot or salon

The rig's console classifier now names the boot and salon decisions the app logs on purpose (`[birthdays]`, `[seenHelps]`, `[overlayStack]`, `[nav]`...) per row, and the app stops saying two things twice: one `[RESTORE]` line per removed conversation (now counted in the census line) and a malformed `[[ATTENTION]` tag ([cross-client-harness](../tools/cross-client-harness/README.md)).

GRP-3 and HEAL-NEW-0 get their own narration lists too (`GROUP_REMOVAL_ROW_NARRATION`, `FRESH_DEVICE_FIRST_SESSION_NARRATION`), each pinned in `classify-selftest.mjs` with controls.
