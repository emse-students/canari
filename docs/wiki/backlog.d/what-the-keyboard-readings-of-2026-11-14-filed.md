## P2 - what the keyboard readings of 2026-11-14 filed: a photo DM still jumps to older messages, a short thread loads history on close, a 12 px step
target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

Read on the owner's Pixel 6a (Android 17, 60 Hz), Canari `1.6.12`, the current stable - which is
`1.6.12-alpha.2`'s commit and does NOT carry the keyboard work of #3490/#3492 that `main` has since -
with the owner's go. The five most recent DMs, each opened
from the list, the composer tapped, the keyboard put away with Back, the DM left. Screen-recorded and
read frame by frame: every bubble's box located by colour against the background, its movement
between frames compared with the others' (a rigid move is every bubble by the same amount). The
instrument and the motion half are in [the motion study](keyboard-motion-like-android-messages.md).
The store build logs nothing from the page and no DevTools socket is open, so **no cause below is
read from the code's own lines; each is a symptom with its frames**.

**Where it goes right.** In a long text DM every visible bubble moves by the same 866-868 px
(physical) on the rise and comes back exactly on the close: the thread moves rigidly, and nothing
reflows. Opening a DM from the list draws its last rows in place, with no frame of movement after
the first one (DMs 1, 2, 3 and 5).

### 1. P2 - a DM whose tail holds photos and a video still lands on OLDER messages when the keyboard opens

DM 4: a long DM whose last rows include a photo, a video and a screenshot. Opened, its last row in
place; the photo near the end stays a blurred placeholder for ~3 s. The composer is tapped: the
photo loads in the frame the keyboard starts (coincidence or trigger, not separated), the keyboard
rises, and **~50 ms after it settles the thread jumps to older messages** (the video, another photo,
a long message), the scroll-down arrow up. Closing the keyboard leaves the reader there.

That is the defect of [a reader at the bottom is anchored to the bottom](../frontend/modules/chat.md#a-reader-at-the-bottom-is-anchored-to-the-bottom-in-both-directions-2026-10-30),
whose owed Android reading this was, and it FAILS on `1.6.12`. **It is a defect with its own entry,
candidate causes and hunt**: [a DM ending in photos lands on older messages](p2-a-dm-ending-in-photos-lands-on-older-messages-when-the-keyboard-opens.md).

### 2. P2 - a short DM closing its keyboard shows a history spinner and jumps twice

DM 3: ~6 rows, shorter than the screen. On the close, mid-animation, a loading spinner appears at
the top (older history asked for, in a DM whose first day is already shown), the thread drops ~80 px
for it, then jumps up ~130 px when it goes, and the composer is missing for one frame. Four
movements for one Back. **The likely trigger, from the code, not from a log**: `measureScroll`
(`ChatArea.svelte`) calls `loadOlderGroups()` whenever `scrollTop < OLDER_TRIGGER_PX`, and a thread
shorter than its pane sits at `scrollTop` 0 for good, so ANY scroll event (the box growing back as
the keyboard leaves) asks for older history, whether or not there is any. Refuted if no
`loadOlderGroups` runs during the close on a dev build.

### 3. P3 - the composer steps 12 CSS px down one frame before every close

In every DM, one frame after Back and before the keyboard moves, the composer moves 30-32 physical
px (12 CSS px at 2.625) down: the footer's resting `0.75rem` changing as the keyboard state flips,
ahead of the layout. Small, and seen in all five.

### 4. Short DMs sit at the top - DECIDED: they move to the bottom (owner, 2026-11-14)

DMs 2 and 3 draw their few rows from the top, with an empty band above the composer, so the keyboard
rise moves nothing but the composer. Messenger bottom-aligns a short thread. **The owner chose the bottom**: a
thread shorter than its pane rests against the composer.
