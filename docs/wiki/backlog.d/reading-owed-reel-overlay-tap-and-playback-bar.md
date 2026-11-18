## P3 - Reading owed - the CanaReel overlay tap and the fixed playback bar, on both phones

target: 1.7.1

Built: a single tap hides or shows the viewer's overlay (no pause on a tap), and the playback line is fixed
to the video's real total with the loaded ranges in grey ([reels](../frontend/modules/reels.md#a-tap-hides-the-overlay-and-the-playback-bar-is-fixed-to-the-real-total-owner-2026-11-18)).
Read on the Mi 9T and the iPhone 12, a CanaReel and a post of one video, in the viewer:

1. Tap the picture: caption, author, rail, tabs and close button hide, the line stays; tap again: they
   return. A long press pauses while held and resumes on release; a swipe and a double tap (like) toggle
   nothing; a tap on a rail button or the close button never hides the overlay. The next reel shows it again.
2. VoiceOver / TalkBack with the overlay hidden: the hidden controls are not read, "Afficher les commandes"
   is, and activating it brings them back.
3. **Slow link** (the bench's throttled profile): open a reel cold. The line must never move backwards while
   segments arrive; its grey part grows ahead of the played part. Repeat on a post of one video that is
   NOT a CanaReel and on a carousel video: the line may show no progress for the first seconds (length
   unknown until read from the tail) and must then appear at the right place with no jump back.
4. A reel received in a conversation (opened from its tile): the line is fixed from the first frame.
