## Reading owed - the push of a request to republish a post

target: 1.7.0

**What is built:** the push of a request to republish a post (D38b, migration 096): the native composers (Kotlin, Swift NSE, ObjC) were never compiled where this was written

**The reading that closes it:** HARDWARE: one reading of the push on the Mi 9T and the iPhone 12 ([profiles-and-access](../profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built))

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, build 100601202, the alpha account; app killed, the phone's push socket connected):** two associations of the beta web seat asked to relay one of alpha's personal posts (`POST /api/posts/<id>/republication-requests`, 201 each). The native service logged `showSimpleNotification: type=social ... deepLink=fr.emse.canari://republication-requests` twice (04:58:29, 04:58:31) and the shade grouped them: "<association> demande à relayer votre publication <post>" for each, in French. The tap opened the app on the PIN gate (cold) and, after the unlock, on the feed rather than on the request inbox. The two requests were withdrawn afterwards. **Left: the iPhone 12.**
