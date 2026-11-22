## P3 - Reading owed - the CanaReel overlay tap and the fixed playback bar, on both phones

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-19, sitting [S9](../device-verification.md#the-phone-readings-of-2026-11-19-s9-171-alpha3) on `1.7.1-alpha.3`: **row 1 PASSED in part on both phones; rows 2-4 are owed.** A tap hides close button, tabs, rail and author with the line kept, and a tap brings them back (Mi 9T and iPhone 12, four alternating taps on the iPhone read through the accessibility tree); on the Mi a rail tap (mute) left the overlay up, the next reel showed it again, and a long press held the frame for 1.5 s and resumed on release. Not read: the double tap and the swipe (a double tap writes a like), the iPhone long press, TalkBack/VoiceOver, the slow link, a reel opened from a conversation._

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

_2026-11-19, sitting [S10](../device-verification.md#the-phone-readings-of-2026-11-19-s10-171-alpha3) on `1.7.1-alpha.3`: **row 1 is now read in full on both phones; row 2 in part; rows 3-4 are owed.** Row 1: a double tap on the Mi liked the reel with no change to the overlay, and a swipe and a rail tap changed nothing either. On the iPhone a 3 s long press left the overlay up and froze the bar (MJPEG frames), and the bar moved again on release. Row 2: with the overlay hidden, the WebView's accessibility tree (Mi, over CDP) and WDA's tree (iPhone) list "Afficher les commandes" and none of the hidden controls. Activating it on the Mi brings them back. TalkBack and VoiceOver were not switched on, so the spoken half is owed. Row 3 was not taken (no throttled link in the sitting). Row 4 is blocked: the card opens `/posts/<id>` instead of the viewer ([filed](p2-a-shared-reel-card-opens-the-post-page-not-the-reels-viewer.md), `1.8.0`), so this row closes with that fix. Seen once on the iPhone and not reproduced: the reels tab opened with its overlay already hidden._
