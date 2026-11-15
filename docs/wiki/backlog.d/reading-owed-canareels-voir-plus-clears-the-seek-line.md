## Reading owed - CanaReels "Voir plus" clears the seek line: the just-overflowing caption and a phone with no bottom inset

target: 1.7.0

**What is built:** CanaReels "Voir plus" clears the seek line (owner, 2026-11-10; the clearance derived in `seekLineGeometry.ts`, 2026-11-11)

**Already read** ([device-verification](../device-verification.md#the-mi-9t-sitting-5-readings-of-2026-11-15---the-verdicts-of-the-entries-it-closed)): on the iPhone 12 (bottom inset, home indicator) the one-line, about-110-character and long captions; on the Mi 9T (gesture navigation, 24 px bottom inset) the one-line and long captions, collapsed and expanded, with no overlap of the two rectangles and the seek line still seeking.

**The reading that closes it:** on the Mi 9T, a caption that JUST overflows (a web seat uploads a reel with one), "Voir plus" toggling and the seek line still seeking (the two `getBoundingClientRect` rectangles do not overlap); and the same on an Android phone with NO bottom inset (three-button navigation, or the Mi 9T switched to it).
