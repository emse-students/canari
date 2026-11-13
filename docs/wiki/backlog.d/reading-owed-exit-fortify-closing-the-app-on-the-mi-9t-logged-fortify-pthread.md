## Reading owed - EXIT-FORTIFY: closing the app on the Mi 9T logged `FORTIFY: pthread_mutex_lock called on a destroyed mutex`, recorded...

target: 1.7.0

**What is built:** EXIT-FORTIFY: closing the app on the Mi 9T logged `FORTIFY: pthread_mutex_lock called on a destroyed mutex`, recorded as a normal exit (`v1.3.1-alpha.5`, [device-readings](../device-readings-2026-10.md), "the stable gate", #2178)

**The reading that closes it:** one Mi 9T app close with `logcat` kept: the name of the thread that locks after shutdown; and whether Play's crash list (`bun tools/play-vitals/vitals.mjs`) carries it
