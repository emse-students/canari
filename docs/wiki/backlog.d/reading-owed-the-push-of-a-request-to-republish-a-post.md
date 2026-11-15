## Reading owed - the push of a request to republish a post

target: 1.7.0

**What is built:** the push of a request to republish a post (D38b, migration 096): the native composers (Kotlin, Swift NSE, ObjC) were never compiled where this was written

**The reading that closes it:** HARDWARE: one reading of the push on the Mi 9T and the iPhone 12 ([profiles-and-access](../profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built))

**iPhone 12 half, READ 2026-11-15 on dev (TestFlight `1.6.12-alpha.2`, build `100601202`, app killed, app language English):** delta, holding `POST_AS_ASSO` in "Club Robotique Fictif", asked through `POST /api/posts/74c3f5a1/republication-requests`; the NSE ran (`type=social`, `outcome=server-content`) and the row read "Club Robotique Fictif asks to share your post" over the post's text "Banc reel 5". The request was withdrawn afterwards. **Left: the Mi 9T half.**
