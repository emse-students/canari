## P2 - held migration 176: the videos already posted become CanaReels, waiting for its approval line

target: 1.7.1

The owner decided on 2026-11-14 that every vertical video, and every video of 90 s or less, is a
CanaReel, and that the videos already posted follow ("Oui, toutes"), each expiring one year after its
publication. The rule is built ([reels](../services/reels.md#the-rule-what-is-a-canareel)); the
conversion is `apps/social-service/src/migrations/176_gallery_videos_become_reels.sql`, HELD
(`-- canari:hold-for-owner`) because it deletes, at the reel worker's next tick, every converted
video published more than a year ago.

**The counts, read-only, 2026-11-14** (the header's two queries):

| Estate | Under 30 days | 30 to 180 days | 180 to 365 days | Over a year (deleted at once) | Multi-media posts with a video (stay posts) |
| --- | --- | --- | --- | --- | --- |
| dev | 2 | 0 | 0 | 0 | 0 |
| production | 39 | 1 | 0 | **0** (oldest post 2026-05-13) | 4 |

So NOTHING is deleted at the conversion: every converted video expires a year after its publication,
the first in 2027.

**The owner's answers of 2026-11-14** ([open-questions](../open-questions.md#decided-2026-11-14---should-canareels-cover-every-short-or-vertical-video-and-for-how-long-owner-2026-11-09)):
multi-media posts with a video, *"Rester des posts"*; the longest vertical CanaReel, *"3 minutes"*.

**Numbered 176** (2026-11-18; 172 on 2026-11-14): `main` reached social 175 while this pull request
waited, and 171 belongs to an open PR (#3539), so the file took the number after the highest on
`main`.

**What the conversion does beyond the rows it writes** (adversarial review of #3528, 2026-11-14) -
for whoever writes the approval line:

- **The converted rows leave every view that reads `kind = 'post'`**: the feed, a pin (a pin is a
  feed concept, `posts.service.ts`), the Suivis tab, the campus trend, the suggestions, and a
  republication shown in the feed. They appear in the CanaReels list instead. Nothing is deleted
  by that move; a pinned single-video post is simply no longer pinned where it showed.
- **No filter on the post's context**: association posts, anonymous posts, `studentsOnly`, an
  institution's reach and a post under moderation are converted like any other. That is consistent
  with the create door, which takes a reel with each of them; a reel keeps every one of those
  columns, so the audience a post had is the audience its reel has.
- **The refused-claims leak**: social-service's next boot claims every live reel's blob for its
  author (`PostMediaRetentionService.backfillReels`). A blob the media index does not credit to the
  post's author (uploaded by someone else, an association's account for instance) is REFUSED and
  keeps its old class - so when that reel expires, `purgeReelBlobs` (the uploader's own file only)
  leaves it, and nothing else ever deletes it. The size of that leak is the `refused` count of the
  line `Reel backfill: N live reel blob(s), R refused, F not reached` at the FIRST social-service
  boot after the release: **owed, read once from the production log**.
- **The rollback covers the database only**: it turns the rows back into posts, but a video the
  worker already deleted is gone, and the blobs keep the `reel` class until the next boot's archive
  pass. Moot here: band 4 is 0, so nothing is deleted before 2027.

Owed, in order:

1. The approval line in `infrastructure/migration-approvals.txt`, by the owner or by the lead under
   the 2026-11-03 delegation - a destructive migration, so after the dev pass.
2. After it ships: the next `[REEL_GC]` tick deletes nothing (band 4 is 0), and the CanaReels
   list gains the 40 production videos.
3. The `refused` count of the first boot's `Reel backfill:` line, above - 0 closes the leak question;
   anything else names the blobs nothing will delete, and they get an entry of their own.
