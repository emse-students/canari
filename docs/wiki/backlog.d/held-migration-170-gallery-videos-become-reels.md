## P2 - held migration 170: the videos already posted become CanaReels, waiting for its approval line

target: 1.7.0

The owner decided on 2026-11-14 that every vertical video, and every video of 90 s or less, is a
CanaReel, and that the videos already posted follow ("Oui, toutes"), each expiring one year after its
publication. The rule is built ([reels](../services/reels.md#the-rule-what-is-a-canareel)); the
conversion is `apps/social-service/src/migrations/170_gallery_videos_become_reels.sql`, HELD
(`-- canari:hold-for-owner`) because it deletes, at the reel worker's next tick, every converted
video published more than a year ago.

Owed, in order:

1. Run the read-only count query in the file's header on dev, then on production (the age bands,
   and the count of multi-media posts it leaves as posts), and write the numbers here.
2. The owner confirms the two reversible choices parked in
   [open-questions](../open-questions.md#decided-2026-11-14---should-canareels-cover-every-short-or-vertical-video-and-for-how-long-owner-2026-11-09)
   (multi-media posts stay posts; a vertical reel is at most 10 min).
3. The approval line in `infrastructure/migration-approvals.txt`, by the owner or by the lead under
   the 2026-11-03 delegation - a destructive migration, so after the dev pass.
4. After it ships: the next `[REEL_GC]` tick's deleted count matches band 4 of the query.
