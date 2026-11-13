## P2 - sending several photos or videos is slow on a bad network, and the send stops when the app goes to the background

target: 1.10.0

Owner report, 2026-11-06 (a heavy evening). The server side is not the cost: the 2026-11-05 evening
read of the production frontend log shows 110 `POST /api/media/upload` at 0.08 s on average (0.25 s
at most) and 2 chunked completions at 0.4 s, so the time is the client's uplink and the work done
before it (encoding, encryption). Nothing in the app lets a send outlive the webview: a backgrounded
app is suspended and the upload dies with it.

**The owner's answers (2026-11-06).** (1) Publish closes the composer at once; the send goes on in the
background behind a discreet progress line with a Retry, and the post is never lost. (2) Backgrounding:
AUTOMATIC RESUME with no native code in this step - the upload pauses when the OS suspends the app and
resumes where it stopped on return. (3) Files go ONE BY ONE, each in resumable parts. (4) Measure
first what is sent per media type, propose reductions, and change no quality without the numbers.

**Step 1, built (the feed post composer).** A durable publish queue per account, the composer closed
at once, files one by one through media-service's resumable sessions (a new `single-block` mode for
photos), a client-minted post id as the idempotency key of `POST /api/posts`, Pause and a Delete
that takes the post back everywhere (a retired id, migration 135; the uploaded media no live row
cites deleted by social-service) ([posts](../frontend/modules/posts.md#the-background-publish-queue)).
Release order: held by itself - the client sends nothing until `/api/version` says `publishQueue`.

**What is left, in order.**

1. **The native step: send while the app is AWAY.** An Android foreground service (or WorkManager
   with an expedited job) and an iOS background `URLSession` upload task, fed the queue's prepared,
   encrypted parts, so a send does not wait for the member to come back. Step 1 only resumes on return.
2. **The other composers on the same queue**: `EditPostForm` (a media added on edit), the comment
   composer, the CanaReels publish, and chat media sharing it (the chat outbox has its own resumable
   path for reels only, RC-5).
3. **The reductions the measurements point to**, each a quality decision for the owner, none taken:
   [the numbers and the three proposals](../frontend/modules/posts.md#what-a-post-sends-measured-2026-11-06-local-estate-desktop-chrome).
   In short: a 12 MP photo leaves as 436 KB (~10 s at 50 kB/s), a 16 s 1080p video as 2.83 MB.
4. **Readings owed**: the Mi 9T and the iPhone 12 (a phone on a weak link, the app backgrounded
   mid-send and brought back), and the production rate of `[POST-CREATE] post <id> sent again`.
5. **The stall detector after a reload on a throttled link**: a reload while a part was in flight
   re-sent that part after an `UploadStalledError` (the reload's own downloads shared the 50 kB/s
   link). It healed, but say whether the stall bound is right for a weak link.
