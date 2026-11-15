## Reading owed - the bell, WP-3 (#3156, first stable `v1.6.8`, migration 143 approved; engagement)

target: 1.7.0

**What is built:** the bell, WP-3 (#3156, first stable `v1.6.8`, migration 143 approved; [engagement](../engagement.md#wp-3---the-bell-built))

**The reading that closes it:** on the Mi 9T and the iPhone 12: an association's bell at "Rien" and a post of it from the other phone - in the feed and the notifications list, no push; "Lives seulement" then a live - pushed; a followed person at "Lives seulement" - post silent, live pushed; unfollow then re-follow - "Publications et lives" again; a mute set before the bell reads "Rien" on the association page and in "Notifications réduites"

**Triage 2026-11-14: Mi 9T about 15 min, iPhone about 15 min** (the "Lives seulement" reading needs a live from the other phone or a web seat).

**Mi 9T, 2026-11-15 (dev, alpha.2 release build, killed app, web seat as the other side): READ except the mute row.** Default level: the post pushed (~40 s fan-out). "Rien": post in the feed and the notifications list, NO push in 3 min. "Lives seulement": the post silent, a live pushed at its first stored segment. A followed person at "Lives seulement": post silent, live pushed. Unfollow then re-follow: the server's bell row is gone and a fresh visit reads "Publications et lives", BUT an association page left open keeps the old level - filed as [the stale bell](p3-an-association-page-keeps-the-old-bell-level-after-a-re-follow-reset-2026-11-15.md). **Left:** the mute-before-bell row ("Notifications reduites"), and the iPhone half.
