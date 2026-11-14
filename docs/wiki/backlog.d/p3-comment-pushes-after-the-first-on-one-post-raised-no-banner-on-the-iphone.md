## P3 - comment pushes after the first on one post raised no banner on the iPhone (read 2026-11-14)

target: 1.7.0

**Seen, not explained:** gamma's own post on dev, comments sent one by one from the delta web seat, the iPhone 12 (`1.6.12-alpha.2`) off the app. The FIRST comment left a row in Notification Center ("Canari Test Delta a commente / reading K comment text") and so did a banner for the second; comments 3 to 7, sent while the app was backgrounded or suspended (4 s, 25 s and 100 s after leaving it) and once killed, raised no banner and no row, while the in-app bell listed all of them. The cause is not read: a per-post or per-author coalescing on the server, a presence rule (a recently live socket), or a push the device refused are all open.

**Next:** read-only on dev, the social and chat-delivery logs for that post's comment pushes (sent, coalesced or skipped, with the reason), and one more run with the app killed for each comment; then fix at the cause. Related reading: [the comment push opens the post at the comment](reading-owed-a-comment-reply-or-mention-opens-the-post-at-the-comment-the-push.md).
