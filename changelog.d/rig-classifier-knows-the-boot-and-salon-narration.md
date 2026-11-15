### Fixed - the cross-client rig no longer reports PASS-DIRTY on a healthy boot or salon

The rig's console classifier now names the boot and salon decisions the app logs on purpose (`[birthdays]`, `[seenHelps]`, `[overlayStack]`, `[nav]`...) per row, and the app stops saying two things twice: one `[RESTORE]` line per removed conversation (now counted in the census line) and a malformed `[[ATTENTION]` tag ([cross-client-harness](../tools/cross-client-harness/README.md)).
