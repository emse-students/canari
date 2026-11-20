## P3 - opening a replay in the CanaReels viewer starts its player twice: the listing and segment 0 are fetched twice (S13, 2026-11-20)

target: 1.7.2

On `1.7.1-alpha.5` (dev), every replay opened from a feed card logs the same sequence 0.35 s apart:
`page <post> active - player for live <id>`, `player start`, `source open`, `page of <id> from 0`,
`61 segments listed (all)`, then `page <post> left the screen - player stopped`, `player stop (connecting)`,
and the same four lines again. `GET /api/lives/<id>/replay` is called twice and segment 0 is
downloaded twice (`70470384` at 12.2 s and 12.5 s in the Mi replay of
[S13](../device-verification.md#the-readings-of-2026-11-20-s13-171-alpha5-replays-sound-under-15-fps-messages-and-the-iphone)),
which is the only repeated index of a replay that has no tail repeat. It coincides with the viewer's
own `GET /api/posts?...feed=reels&...withReplays=true` answering (the reel list re-keys the page
that was just activated). Harmless to the picture; it is an unexplained line pair and two requests per
open, so a defect of the same family as the one beside it. **Test first**: open a replay with the
fake list answering after the first `active`, and count `start` per live id: 1.
