## Reading owed - the undated last-resort KeyPackages left on production

target: 1.7.0

**Re-measured read-only on prod 2026-10-10: 454 undated of 1027 rows (290 users), newest undated row still 2026-09-25 - the drain is now about 3 a day.** **Re-measured 2026-10-09: 457 undated of 1016 rows (291 users, 116 of them with NO dated row), down from 597 on 2026-09-22 - about 8 a day, the 20 a day of 2026-09-18 slowing.** The split is STILL a client version with no exception (559 of 559 dated rows are `>= 0.18.10`; no undated row is, 393 carry no version at all and 29 are below it), and the newest undated row was created 2026-09-25: the population is frozen and only drains. Both client repairs are REFUTED; mechanism in [key-package-pool](../protocols/key-package-pool.md). **The server-side lifetime decoder (an MLS reader in `chat-delivery-service`, which never interprets MLS bytes) is NOT justified while the count falls**; a count that stops falling is what would justify it, so re-measure after the floor moves ([the floor rule](../legacy-compatibility.md#the-floor-rule-raised-when-both-stores-serve-the-latest-update-owner-2026-10-24)) - which is also what empties it.

**Re-measured read-only on prod 2026-11-14: 133 undated of 940 rows (99 users), newest undated row
2026-09-16 - still falling, about 9 a day since 2026-10-10 (454).** The decoder stays unjustified.
Since the floor is `1.6.6`, no device holding an undated row can connect without republishing a dated
one, so the rest belongs to devices not seen since; the stale-device GC (90 days) reaches the
youngest of them in mid-December. Re-measure then.
