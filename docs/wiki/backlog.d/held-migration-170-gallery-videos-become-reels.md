## P2 - held migration 170: the videos already posted become CanaReels, waiting for its approval line

target: 1.7.0

The owner decided on 2026-11-14 that every vertical video, and every video of 90 s or less, is a
CanaReel, and that the videos already posted follow ("Oui, toutes"), each expiring one year after its
publication. The rule is built ([reels](../services/reels.md#the-rule-what-is-a-canareel)); the
conversion is `apps/social-service/src/migrations/170_gallery_videos_become_reels.sql`, HELD
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

Owed, in order:

1. The approval line in `infrastructure/migration-approvals.txt`, by the owner or by the lead under
   the 2026-11-03 delegation - a destructive migration, so after the dev pass.
2. After it ships: the next `[REEL_GC]` tick deletes nothing (band 4 is 0), and the CanaReels
   list gains the 40 production videos.
