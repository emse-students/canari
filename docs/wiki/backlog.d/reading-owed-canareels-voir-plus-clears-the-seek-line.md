## Reading owed - CanaReels "Voir plus" clears the seek line

target: 1.7.0

**What is built:** CanaReels "Voir plus" clears the seek line (owner, 2026-11-10; the clearance derived in `seekLineGeometry.ts`, 2026-11-11)

**The reading that closes it:** On the Mi 9T and the iPhone 12: a caption of one line (no toggle), just overflowing, long and expanded, with and without the bottom inset - "Voir plus" toggles, the seek line still seeks (the two `getBoundingClientRect` rectangles do not overlap)
