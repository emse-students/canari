## Reading owed - a DM ending in photos and a video stays at its last message when the keyboard opens (Pixel 6a)

target: 1.7.3

**What is built.** The photo DM of 2026-11-14 (`1.6.12`, Pixel 6a: ~50 ms after the keyboard settled
the thread jumped to older messages and stayed there) was not reproduced on a phone. Its mechanism
was reproduced in Chrome with the real observer and the real flag rule: a thread that shrinks in one
frame and grows back in the next left the reader above the newest rows, because the scroll
measurement read the thread's own move as the reader going up. The pane's placements are now the
baseline of that measurement (`observeThreadGrowth`'s `onPlaced`). Mechanism:
[chat](../frontend/modules/chat.md#the-flag-is-only-ever-the-readers-2026-11-21).

**The reading that closes it**, on the owner's Pixel 6a, a `1.7.3` pre-release carrying the change:

1. The DM of the report (or one ending in a portrait photo, a video and a screenshot), opened from the
   list; wait for the last photo to leave its blurred placeholder, then once before it has.
2. Tap the composer: the keyboard rises, the thread follows it, and the last row stays right above
   the composer once the keyboard has settled - the scroll-down arrow never shows.
3. Back: the keyboard leaves and the thread is still at its last message. Repeat three times.
4. If it jumps anyway, export the in-app log at once: the cause is then NOT the one fixed here
   (it logs nothing at the flag, so note the screen recording and the exact frame).

**Mi 9T sitting, 1.7.3-alpha.5 (2026-11-22): the keyboard-open row was exercised on the Mi; no verdict was carried through a context reset, so it stays open and is not promoted to PASS.**
