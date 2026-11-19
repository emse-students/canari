## P3 - A browser whose storage is broken is told the connection failed (KILL-2, 2026-10-25)

target: 1.9.0

When the browser serves no storage at all - `indexedDB` and `navigator.storage.estimate()` both
throw `Internal error`, `localStorage` an empty in-memory store - the page boots to the PIN gate
and says *"La connexion n'a pas abouti. Réessayez dans un instant."*, with the status pill on
*Hors-ligne*. Nothing is wrong with the connection, and retrying never helps: the user cannot tell
that their browser's storage is the fault, nor that a browser restart is the cure. Seen on
`1.4.1-alpha.3` after a test rig's whole-browser kill left a Chrome profile without its quota
database (the data was intact on disk and came back on a clean restart, so the product wiped
nothing). The fix is to classify a storage failure at boot as its own type where it is thrown, so
the gate can name it; whether it earns a distinct message is decided with the fix.
Re-read 2026-11-11: still real - no storage-failure type exists in `frontend/src/lib`. Re-read again 2026-12-11.
