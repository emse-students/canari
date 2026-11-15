## Reading owed - the bell, WP-3 (#3156, first stable `v1.6.8`, migration 143 approved; engagement)

target: 1.7.0

**What is built:** the bell, WP-3 (#3156, first stable `v1.6.8`, migration 143 approved; [engagement](../engagement.md#wp-3---the-bell-built))

**The reading that closes it:** on the Mi 9T and the iPhone 12: an association's bell at "Rien" and a post of it from the other phone - in the feed and the notifications list, no push; "Lives seulement" then a live - pushed; a followed person at "Lives seulement" - post silent, live pushed; unfollow then re-follow - "Publications et lives" again; a mute set before the bell reads "Rien" on the association page and in "Notifications réduites"

**Triage 2026-11-14: Mi 9T about 15 min, iPhone about 15 min** (the "Lives seulement" reading needs a live from the other phone or a web seat).

**iPhone 12 half, partly READ 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev; gamma follows Club randonnee `d9c7ddf6`, delta posts as it):
- **"Rien", then a post from the other side.** The bell was set to "Rien" on the association page (`[BELL] 223bc34e association=d9c7ddf6 -> none`). Delta then published post `b67b7007` as the club. The server logged `[NOTIFY] type=association_post association=d9c7ddf6 push withheld by the bell from 1 of 22`. No banner reached the phone. The post is in the Organisations feed, and gamma's `association_post` row is in the notifications list. READ.
- **Unfollow, then re-follow.** The server reset the bell (`[FOLLOW] ... followed, bell reset`), and the association page read "Publications et lives" when it was opened again. READ. The page did not refresh in place, though: right after "Suivre" it still showed "Rien" ([P3](p3-the-bell-picker-keeps-its-old-level-after-a-re-follow.md)).
- **A mute set before the bell.** Club d'Echecs Fictif (`f1ddbfe2`, muted before migration 143) is listed under "Notifications reduites" with "Rien". READ.

- **"Lives seulement" on an association, then a live (READ 2026-11-15, second sitting).** The bell of Club d'Echecs Fictif (`f1ddbfe2`) was followed afresh and set to "Lives seulement" (the page read "Lives seulement"), the app was put in the background, and the other account went live AS the association from the rig seat W5 with a title. The server logged `[LIVE_ANNOUNCE] ... kind=association followers=22 titled=true` and `[SOCIAL_PUSH] sent ... platform=ios` to the phone, and a banner "Club d'Echecs Fictif est en live / Tournoi blitz 1115b" was captured on the home screen. READ. (Club randonnee `d9c7ddf6` could not be used for this: its first live of the day sets a 6 h announcement window, `not announced: association d9c7ddf6 announced a live ... less than 6 h ago`, so a second live of an association inside 6 h is never pushed, by design.)
- **A followed person at "Lives seulement" (READ 2026-11-15).** The phone's account asked to follow the other account (a person account is private: the request was accepted on W5), the bell on the profile was set to "Lives seulement", then (a) a PERSON post: `[NOTIFY] type=followed_post user=43319a65 push withheld by the bell from 1 of 1`, no banner, the post in the feed; (b) a PERSON live: `[LIVE_ANNOUNCE] ... kind=member followers=1 titled=true`, `[SOCIAL_PUSH] sent ... platform=ios`, and SpringBoard logged `Posting notification ... section: fr.emse.canari` the same second. READ.

**Left on the iPhone: nothing.** The Mi 9T half is the rest of this entry.
