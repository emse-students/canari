### Changed - Test rig: TAB-3b no longer blames the product for a cookie jar a hard kill lost

TAB-3b now waits for the refresh cookie to reach disk before each kill, checks the jar and the storage after it, and records a signed-out seat as INVALID (blocked on the rig), sharing the KILL rows' helpers ([cookiejar.mjs](tools/cross-client-harness/cookiejar.mjs), [backlog](docs/wiki/backlog.d/p2-an-unclean-kill-of-a-browser-inside-30-s-of-a-rotation-signs-the-user-out.md)).
