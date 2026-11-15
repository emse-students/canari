## Reading owed - the bell, WP-3 (#3156, first stable `v1.6.8`, migration 143 approved; engagement)

target: 1.7.0

**What is built:** the bell, WP-3 (#3156, first stable `v1.6.8`, migration 143 approved; [engagement](../engagement.md#wp-3---the-bell-built))

**The reading that closes it:** on the Mi 9T and the iPhone 12: an association's bell at "Rien" and a post of it from the other phone - in the feed and the notifications list, no push; "Lives seulement" then a live - pushed; a followed person at "Lives seulement" - post silent, live pushed; unfollow then re-follow - "Publications et lives" again; a mute set before the bell reads "Rien" on the association page and in "Notifications réduites"

**Triage 2026-11-14: Mi 9T about 15 min, iPhone about 15 min** (the "Lives seulement" reading needs a live from the other phone or a web seat).

**Mi 9T, 2026-11-15 (dev, alpha.2 release build, killed app, web seat as the other side): READ except the mute row.** Default level: the post pushed (~40 s fan-out). "Rien": post in the feed and the notifications list, NO push in 3 min. "Lives seulement": the post silent, a live pushed at its first stored segment. A followed person at "Lives seulement": post silent, live pushed. Unfollow then re-follow: the server's bell row is gone and a fresh visit reads "Publications et lives", BUT an association page left open keeps the old level - filed as [the stale bell](p3-the-bell-picker-keeps-its-old-level-after-a-re-follow.md), seen on both phones. **Left:** the mute-before-bell row ("Notifications reduites") on the Mi 9T (read on the iPhone). Build note: read on `v1.6.12-alpha.2` (built for dev, tag on `fa1bc2655`), not the stable APK; `v1.6.12` is the bump commit `0b6947d20` directly over it (version files and changelog fragments only), so the code read is the stable's.

**iPhone 12 half, partly READ 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev; gamma follows Club randonnee `d9c7ddf6`, delta posts as it):
- **"Rien", then a post from the other side.** The bell was set to "Rien" on the association page (`[BELL] 223bc34e association=d9c7ddf6 -> none`). Delta then published post `b67b7007` as the club. The server logged `[NOTIFY] type=association_post association=d9c7ddf6 push withheld by the bell from 1 of 22`. No banner reached the phone. The post is in the Organisations feed, and gamma's `association_post` row is in the notifications list. READ.
- **Unfollow, then re-follow.** The server reset the bell (`[FOLLOW] ... followed, bell reset`), and the association page read "Publications et lives" when it was opened again. READ. The page did not refresh in place, though: right after "Suivre" it still showed "Rien" ([P3](p3-the-bell-picker-keeps-its-old-level-after-a-re-follow.md)).
- **A mute set before the bell.** Club d'Echecs Fictif (`f1ddbfe2`, muted before migration 143) is listed under "Notifications reduites" with "Rien". READ.

**Left on the iPhone: "Lives seulement" then a live, and a followed person at "Lives seulement".** Both need a live from the other side.

**Attempt of 2026-11-15 (iPhone, second sitting): not read.** The bell of Club randonnee was set to "Lives seulement" on the phone (the page showed it). The fourth account's web seat was relaunched with the fake-device flags (without them `getUserMedia` is refused and "Demarrer le live" stays disabled), the live was started as the club, and the seat's Chrome stopped answering on its debugging port right after "Demarrer le live", with no push seen on the phone. A live that never reached the server proves nothing, so the row stays. Next time: start the live from a seat whose browser survives the start (note the crash, with the fake camera, as the thing to explain first).
