## P2 - a reply or a mention aimed at a post's AUTHOR is sent as a "comment", so the daily cap swallows it

target: 1.8.0

**Measured 2026-11-15 on dev (iPhone 12, TestFlight `1.6.12-alpha.2`, gamma's own reel `74c3f5a1`, the
delta web seat writing).** `PostInteractionsService.addComment` tells the post's author FIRST, always as
`comment`, and puts them in `alreadyNotified`; the reply and mention passes then skip them. A
`comment` push is COUNTED by the daily engagement cap (`ENGAGEMENT_DAILY_PUSH_CAP = 3` per Paris day,
WP-8, [engagement](../engagement.md)), while a reply and a mention are not ("everything a person needs or
asked for does not" count, `engagement-push-cap.ts`). So a reply to the author's own comment arrived
as "Canari Test Delta a commenté", and once the day's three were spent a comment MENTIONING the
author raised no push at all: social-service logged `[NOTIFY] type=comment withheld 1 of 1 (cap,
category comments off, or no device at any build) - the bell rows stay`. The same mention on a post
the reader does not own pushed at once ("Canari Test Delta vous a mentionné"), past the cap.

**This is also the whole of the old P3 "comment pushes after the first on one post raised no
banner on the iPhone" (2026-11-14, deleted here):** comments 3 to 7 on gamma's own post were the cap
doing its work, not a coalescing, a presence rule or a refused push.

**Fix at the cause:** decide the author's notice type by what the comment IS to them - a reply to
their comment is a `reply`, a mention of them a `mention`, else a `comment` - so the uncounted kinds
stay uncounted; `post-interactions.comment-notify.spec.ts` gains the author-is-the-parent and
author-is-mentioned cases.
