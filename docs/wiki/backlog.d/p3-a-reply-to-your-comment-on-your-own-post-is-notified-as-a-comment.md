## P3 - a reply to your own comment on your own post is notified as a "comment": it reads "a commenté" and counts against the daily push cap

target: 1.7.0

Measured on the Mi 9T against dev on 2026-11-15 (`1.6.12-alpha.2`, the alpha account's post f1a6cac0, replies from the beta web seat). Beta replied to alpha's comment on alpha's own post. The push and the bell row said "a commenté", where a reply says "a répondu". Each reply was also counted against the engagement cap: comments are counted, replies and mentions are free (`ENGAGEMENT_DAILY_PUSH_CAP`, 3 per Paris day, `engagement-push-cap.ts`).

The cause is in `apps/social-service/src/posts/post-interactions.service.ts` (`createComment`, about L291-L373). The post author is sent `'comment'` first and added to `alreadyNotified`, so the reply loop then skips them. When the parent comment's author IS the post author, the more specific `'reply'` never goes out. The fix is to resolve each recipient's most specific kind before sending (mention > reply > comment), not first-come.

The test that would lift it: a service test where the post author is also the parent comment's author, expecting one `'reply'` and no cap charge.
