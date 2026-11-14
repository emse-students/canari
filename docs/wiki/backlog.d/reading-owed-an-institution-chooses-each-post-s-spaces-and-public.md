## Reading owed - an institution chooses each post's spaces and public

target: 1.7.0

**What is built:** an institution chooses each post's spaces and public (#3314, migration 162, first stable `v1.6.10`; [profiles-and-access](../profiles-and-access.md#an-institutions-reach-per-post-as-built-owner-2026-11-10))

**The reading that closes it:** on dev: an institution member publishes to two spaces and "Étudiants" - read by a student of a ticked space, NOT by a student of an unticked space of the institution's audience, NOT by a named reader whose cell covers a ticked space (feed, search, the post by its link, its bell row); edited to "Personnel", the named reader reads it at once and the student no longer does; on the Mi 9T and the iPhone 12, light and dark: the picker, its hint and the disabled "Publier" in the composer, the reel publish step and the edit form, the chip on a card and in the CanaReels viewer; a week after the stable, read-only on production: `SELECT "reachPublic", count(*) FROM posts WHERE "reachPublic" IS NOT NULL GROUP BY 1`

**Added 2026-11-14 - staff by campus ("Oui, par campus"):** on dev, a staff account of Saint-Etienne
with no membership, grant or follow opens the feed, reads a "Personnel" post of a ticked
Saint-Etienne space (feed, search, by link) and receives its bell row; a staff account of another
campus does not; the same post edited to "Étudiants" disappears for the first. And a week after the
stable, read-only on production: the count of staff accounts per campus (`campus IS NOT NULL AND
cursus = '[]'`), to know how many a "Personnel" post now reaches.
