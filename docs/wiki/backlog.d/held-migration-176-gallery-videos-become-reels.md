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

**Re-read on 2026-11-19, production: 47 posts would convert** (10 landscape or square, 37 vertical),
none a year old, so nothing is deleted before about November 2027. **The owner confirmed it the same
day** (*"Oui, toutes"*), having seen production examples of what it converts, horizontal clips
included: EVERY already-posted single-video post, whatever its frame and length.

**The owner's answers of 2026-11-14** ([reels](../services/reels.md#the-rule-what-is-a-canareel), [decisions of 2026-11-19](owner-decisions-of-2026-11-19.md) item 8):
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

**The video test was narrowed on 2026-11-18** (review of the 1.7.1 rework): a `video/*` mimeType AND a
`type` that is `video` or absent, as the create door asks - the counts above were read with the
looser `type = 'video' OR mimeType video/*`, so they are re-read with the file's own query before
the approval line is written.

**The charter, principle 2 ("L'essentiel ne se perd pas": an announcement is found when it is looked
for).** The conversion takes ASSOCIATION posts too: a single-video announcement leaves the
association's feed (it reads `kind = 'post'`), joins the CanaReels list, and is deleted a year after
its publication. The owner's *"Oui, toutes"* covers it, but whoever writes the approval line confirms
the association case explicitly, with the counts re-read split by `"associationId" IS NOT NULL`.

**THE ORDER IS DECIDED BEFORE THE PULL REQUEST LEAVES DRAFT.** A held file on `main` with no approval
line refuses EVERY release (gate 6, [cicd](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)),
and dev is held like production, so "a pass on dev first" cannot precede the approval: either the
approval line merges with (or right after) this PR, or the code ships first and file 176 moves to a
pull request of its own, merged when the approval is ready. Until then the PR stays draft.

Owed, in order:

1. The counts re-read with the file's own query (read-only), then the approval line in
   `infrastructure/migration-approvals.txt`, by the owner or by the lead under the 2026-11-03
   delegation - its order with the merge as above.
2. After it ships: the next `[REEL_GC]` tick deletes nothing (band 4 is 0), and the CanaReels
   list gains the 47 production videos (the read of 2026-11-19).
3. The `refused` count of the first boot's `Reel backfill:` line, above - 0 closes the leak question;
   anything else names the blobs nothing will delete, and they get an entry of their own.
