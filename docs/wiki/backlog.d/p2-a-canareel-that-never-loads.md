## P2 - a CanaReel that never loads (owner, Android, 1.6.8, 2026-11-09): the outcome line is built, the cause is owed one reading

**Reported:** on an Android phone running `1.6.8`, CanaReels videos "did not load" - mostly a reel
that stays on its poster or spinner, not an error. His exported in-app log (a week, `L/I/W/E`) held
NO line about any reel: every reel diagnostic was `Log.d`, and the in-app log records no debug. What
it did hold, the same evening: `[CONNECTIVITY] slow link` episodes (latency floor ~1 s with 14
requests in flight) and `GET /api/posts/notifications had no response after 20000 ms` - **a request
that never received a response head does happen on this phone's link.**

**Built (this entry's PR):** one `[reel-view]` info line per reel view, written when the reel leaves
the screen - the first frame and its time, or `NO first frame` and the last stage the load reached,
with the source kind, the segments or bytes, the preload state, the media gate's counts and the
element's `readyState` / `networkState` ([reels](../frontend/modules/reels.md#one-line-per-reel-view-the-outcome-the-in-app-log-carries-owner-2026-11-09)).

**Candidate causes, read from the code, none measured** - each names the line that would show it:

1. **A media request that never answers holds its slot for ever.** Every media byte goes through
   `mediaRequestGate` (three at once, FIFO, `utils/requestGate.ts`). The API layer gives up on a
   request silent for 10 s with no response head (`StalledRequestError`); a media GET has no such
   watch - neither the whole read (`fetchMediaObject`, whose `fetch` is aborted only when nobody holds it) nor a stream's
   ranges (`httpRangeSource`). A started load stays joinable while anyone holds it (`mediaBlobCache.ts`,
   `SharedLoad`; since 2026-11-11 one nobody holds is aborted), so a reel re-opened while it is
   still held JOINS the dead request. Three dead requests (feed cards,
   avatars, chat media) stop every media byte in the app. Shows as `stopped at: downloading the
   whole file` or `waiting for the file header` with `media gate 3 running`, across several reels.
2. **The reel on screen queues behind the feed under the viewer.** The gate has no priority: feed
   media and avatars already started keep their slots while the reel waits. Shows as `media gate 3
   running N queued` on a reel that then loads late.
3. **A reel read whole on a weak link.** A reel whose ref names no codecs (`whole (no-codecs)`) is
   downloaded whole, ~28 MB, before its first frame - about 55 s at 400 kbit/s (reels page, 2026-11-04
   reading). Not a hang, but the reader leaves first. Shows as `whole (no-codecs) 28.0 MB not in`.
4. **A preload racing a streamed reel.** A preload still on the wire at the swipe keeps its whole
   read (and a gate slot) while the stream opens its own ranges of the same file. Shows as
   `stream ..., preload in-flight` with a slow first frame.
5. **The engine takes the bytes and decodes nothing**, with no `MediaError`. Shows as `file handed
   to the element, no metadata decoded` or `metadata decoded, no frame`, with the element's states.

**Why nothing was fixed yet:** causes 1, 2 and 4 live in `mediaBlobCache.ts` and
`segmentedMediaReader.ts`, which another batch (the shared video player, #3197-#3202) was editing,
and the choice between them is the reading's to make, not a guess's. Cause 1's fix would be the API
layer's own rule carried to media: a request with no response head is a typed `MediaUnreachableError`
(the failure is drawn with its Retry), and a load that failed that way is not joinable.

**The reading that settles it:** a pre-release on the Mi 9T, the link shaped by the TCP shaper
([offline-and-weak-network](../frontend/offline-and-weak-network.md), `bun shaper.mjs` + `adb
reverse`, profiles 400/400 kbit and 800/50 kbit): open CanaReels from the feed while its media
loads, swipe ten reels at the reader's pace, then cut the link mid-download (`adb shell svc wifi
disable; svc data disable`) and restore it. Export the in-app log and count the `[reel-view]` lines
by `stopped at` stage and gate counts. And the owner's next export from his own phone, now that the
line exists.
