### Changed - Test rig: TAB-3b no longer blames the product for a cookie jar a hard kill lost

TAB-3b now waits out the cookie commit window before each kill, reads the jar file and the storage after it, and records only a rig casualty as INVALID (blocked on the rig); a signed-out seat with the jar intact stays a FAIL, sharing the KILL rows' helpers ([cookiejar.mjs](tools/cross-client-harness/cookiejar.mjs), [backlog](docs/wiki/backlog.d/p2-an-unclean-kill-of-a-browser-inside-30-s-of-a-rotation-signs-the-user-out.md)).
