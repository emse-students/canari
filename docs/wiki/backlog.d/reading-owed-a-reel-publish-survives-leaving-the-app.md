## Reading owed - a CanaReel publish survives the screen sleeping and the app being left

target: 1.8.1

_2026-11-25: moved to 1.8.1 when 1.8.0 shipped._

Built 2026-11-24: the CanaReels camera's "Publier" queues the take in the background publish queue,
and the screen stays on while a post is worked on ([reels](../frontend/modules/reels.md#publishing-r3-on-c2-and-c3),
[posts](../frontend/modules/posts.md#the-background-publish-queue)). Unit tests pin the resume after a
cut at each step and the single create; the phone has not been read.

The reading, on the Mi 9T with battery saver ON and a throttled link: (1) record a reel, press
"Publier", put the phone down without touching it - the screen must stay on while the banner says
"Envoi" and go to sleep once nothing is sent (`[PUBLISH-QUEUE] screen held on` / `released`); (2)
record another, press "Publier", leave the app mid-upload (home button), come back after a minute -
the banner resumes from its part and the reel is published ONCE (one `[PUBLISH-QUEUE] <id> published`,
one card in the feed); (3) the same with "Envoyer a..." and a conversation ticked - one upload,
the chat bubble plays the published file (`adopts` in the log). The iPhone 12 reads (1) and (2).

**2026-11-25, `1.8.1-alpha.1` (iPhone 12): row (1) PASS, row (2) FAIL and fixed.** Row (1): every publish
logged `iOS idle timer held` with `screen held on: a publish is being sent`, then `released` with
`screen released: nothing is being sent` once done. Row (2), four reels: a leave 2.5 s after "Publish",
or one once the encode had finished, published once; but **Home pressed about 1 s after "Publish",
while the take was being PREPARED, stopped the post at "Failed: Preparing the video failed" with Retry
and a bin** - `refused at mediaPrepare VideoPrepareError: video: the encoder failed`, 47 ms before
`App in background` - where this entry promises "kept, it resumes". Retry in the foreground published
it once. The system tears WebKit's hardware encoder down as the app resigns active; the queue read that
as a refusal. **Fixed (`fix/reel-encode-survives-leaving`):** an encoder failure while the app was out
of view at any moment of the conversion is the `interrupted` fault, typed at the throw from the
lifecycle edges, never the message; the queue keeps the post and prepares it again on the edge that
brings the app back in view ([posts](../frontend/modules/posts.md#the-background-publish-queue)). **The
reading owed on the next alpha, iPhone 12 then Mi 9T:** Home within about 1 s of "Publish", back after
a minute - no "Failed" row; the log reads `[video-prep] the encoder stopped while the app was out of
view` and `[PUBLISH-QUEUE] <id> its preparation was interrupted as the app left the view` (both at
info, no `E` line), then `back in view: preparing it again` and ONE `published`. Rows (2) without the
early leave and (3) stay as written.
