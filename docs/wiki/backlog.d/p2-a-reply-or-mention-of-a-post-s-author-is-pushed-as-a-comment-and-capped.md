## P2 - a reply or a mention aimed at a post's AUTHOR is sent as a "comment" (it read "a commente" and the daily cap swallowed it; the cap half is fixed by #3579)

target: 1.8.0

**Measured twice on 2026-11-15, on dev, build `1.6.12-alpha.2` (`100601202`).**
- **iPhone 12 (TestFlight), gamma's own reel `74c3f5a1`, the delta web seat writing.**
- **Mi 9T (release APK), the alpha account's post `f1a6cac0`, replies from the beta web seat.**

`PostInteractionsService.addComment` (`post-interactions.service.ts`) tells the post's author FIRST, always
as `comment`, and puts them in `alreadyNotified`; the reply and mention passes then skip them. So when the
parent comment's author IS the post author, the more specific `reply` never goes out, and a comment that
MENTIONS the author goes out as a plain `comment`. What each device saw:
- a reply to the author's own comment arrived as "a commente" (push and bell row), where a reply says
  "a repondu" (both phones);
- on the iPhone, once the day's three counted pushes were spent, a comment MENTIONING the author raised no
  push at all: social-service logged `[NOTIFY] type=comment withheld 1 of 1 (cap, category comments off, or
  no device at any build) - the bell rows stay`;
- the same mention on a post the reader does not own pushed at once ("vous a mentionne"), past the cap.

**This is also the whole of the old P3 "comment pushes after the first on one post raised no banner on the
iPhone" (2026-11-14, deleted):** comments 3 to 7 on gamma's own post were the daily cap doing its work, not
a coalescing, a presence rule or a refused push.

**2026-11-15, the cap half is fixed by #3579**, which takes comment and reaction pushes out of the daily cap
(`ENGAGEMENT_DAILY_PUSH_CAP`, [engagement](../engagement.md)) and collapses them per post, so nothing is
swallowed any more. **What remains is an owner question, held by the lead:** should a reply or a mention aimed
at the post's author ring as a `reply` / `mention` of its own, rather than as the author's `comment`? Until it
is answered, this entry stays for that half.

**If the answer is yes, the fix is at the cause:** decide the author's notice type by what the comment IS to
them (a reply to their comment is a `reply`, a mention of them a `mention`, else a `comment`; the most
specific wins, not first-come); `post-interactions.comment-notify.spec.ts` gains the author-is-the-parent and
author-is-mentioned cases.
