## P2 - the CanaReels caption's "Voir plus" overlaps the playback progress bar (owner, 2026-11-10)

**Reported by the owner on 2026-11-10, on a production build. Fix later** - not in the 1.6.9 feed
tabs change (that change does not touch the reel caption layout, so it neither worsens nor fixes
this).

**The two controls.**

- The caption's "Voir plus" / "Voir moins" button: `frontend/src/lib/components/reels/ReelSlide.svelte`
  (the `overflows || expanded` block, `m.post_voir_plus()`), placed above the slide's bottom edge by
  `bottomPad` (the safe-area inset plus 1 rem).
- The playback progress line, its 32 px touch target on the frame's bottom edge:
  `frontend/src/lib/components/ui/player/VideoScrubber.svelte`, mounted by
  `frontend/src/lib/components/shared/VideoPlayer.svelte`.

`bottomPad`'s comment assumes one rem clears the scrubber's touch target; the owner's report says it
does not, at least on the device and caption he used.

**What a fix must prove**, in a test or a reading named in the PR:

- BOTH controls are tappable - the button toggles the caption, the scrubber seeks - at every caption
  length: one line (no button), just overflowing, long, and expanded;
- at phone widths 360, 390 and 430 px;
- with and without the iOS bottom safe-area inset (a frame that reaches the screen bottom, and one
  that does not - `frameReachesBottom`).

Measure the two rectangles (`getBoundingClientRect`) rather than eyeballing them: the overlap is a
geometry fact, and the fix derives the caption's bottom room from the scrubber's own height, never a
second hand-picked constant.
