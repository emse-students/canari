## P3 - reading owed: a photo sent as a reply has no frame, and its quote shows a thumbnail

target: 1.8.3

Built 2026-11-27 on the owner's two minifixes ([chat](../frontend/modules/chat.md#a-quoted-photo-is-drawn-not-named-2026-11-27)). Owed on a phone, both themes, a DM:

- reply with a photo to a photo: no yellow edge around the reply, the quote attached above it;
- the quote draws the photo small and semi-transparent when the original is on screen, its blurred placeholder when only that is held, and "Photo" when the original is not in the loaded thread;
- a video quote draws its blurred placeholder when it has one, else the label (never a first frame: that would pin the video blob);
- the media-only reply keeps `rounded-bubble` on all four corners under the stacked quote: check the seam reads as attached;
- a reply to a CanaReel, a file or a voice note keeps its text quote.

**2026-11-27, `1.8.3-alpha.1`, iPhone 12:** the light pass passed, and the dark pass found the quote GONE after a cold start (header and thumbnail): a file sent as a reply was sent and stored without its quote once its upload ended in the page's life ([chat](../frontend/modules/chat.md#a-reply-keeps-its-quote-after-a-restart-2026-11-27)). Owed again on the next alpha, with a NEW reply photo: send it, kill and relaunch the app, and the header and thumbnail must still be there (both themes), and the peer's copy must carry the quote too.

Delete this entry once read.
