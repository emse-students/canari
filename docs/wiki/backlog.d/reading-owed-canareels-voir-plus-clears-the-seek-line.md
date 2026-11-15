## Reading owed - CanaReels "Voir plus" clears the seek line

target: 1.7.0

**What is built:** CanaReels "Voir plus" clears the seek line (owner, 2026-11-10; the clearance derived in `seekLineGeometry.ts`, 2026-11-11)

**The reading that closes it:** On the Mi 9T and the iPhone 12: a caption of one line (no toggle), just overflowing, long and expanded, with and without the bottom inset - "Voir plus" toggles, the seek line still seeks (the two `getBoundingClientRect` rectangles do not overlap)

**Triage 2026-11-14: Mi 9T about 10 min, iPhone about 10 min** (a web seat uploads reels with a one-line, a just-overflowing and a long caption).

**iPhone 12 half, READ 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev; the rig seat W5 uploaded three CanaReels of a 4 s vertical clip with a one-line caption, a caption of about 110 characters and one of about 790): the one-line caption draws NO toggle; the 110-character caption is clamped to two lines with "Voir plus", which expands it to "Voir moins" (button rectangle `y` 705-725 pt, 20 pt tall) while the seek slider's own zone starts at `y` 736 pt: the rectangles do not overlap (WDA rects); the long caption expands to the full text, "Voir moins" at the same place; in both expanded states a tap on the seek line moved the slider reading (0:00 to 0:02, 0:03 to 0:01 of 0:04) and "Voir moins" still collapsed it. READ with the bottom inset the iPhone 12 has (home indicator). **Left: the Mi 9T, and the case WITHOUT a bottom inset (an Android phone with three buttons).**

**Mi 9T half, PARTLY READ 2026-11-15** (`1.6.12-alpha.2`, dev, gesture navigation, `--safe-area-inset-bottom` 24 px; the reels already on dev, no upload): a caption of one line ("Banc paysage 1") draws NO toggle; a long caption (about 90 characters, clamped) shows "Voir plus", whose rectangle (CSS px, WebView `getBoundingClientRect`) is `top` 800 / `bottom` 814 while the seek slider's own rectangle is `top` 828 / `bottom` 860: no overlap, collapsed and expanded ("Voir moins", same place). In the expanded state a tap on the seek line moved the slider from 0:00 to 0:03 of 0:04 and "Voir moins" still collapsed the caption back to "Voir plus". **Left: the just-overflowing caption on the Mi 9T (needs a reel uploaded with one), and the case WITHOUT a bottom inset (an Android phone with three buttons).**
