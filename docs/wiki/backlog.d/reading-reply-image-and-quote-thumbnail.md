## P3 - reading owed: a photo sent as a reply has no frame, and its quote shows a thumbnail

target: 1.8.3

Built 2026-11-27 on the owner's two minifixes ([chat](../frontend/modules/chat.md#a-quoted-photo-is-drawn-not-named-2026-11-27)). Owed on a phone, both themes, a DM:

- reply with a photo to a photo: no yellow edge around the reply, the quote attached above it;
- the quote draws the photo small and semi-transparent when the original is on screen, its blurred placeholder when only that is held, and "Photo" when the original is not in the loaded thread;
- same for a video (first frame);
- a reply to a CanaReel, a file or a voice note keeps its text quote.

Delete this entry once read.
