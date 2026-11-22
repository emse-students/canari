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

**iPhone 12, `1.7.3-alpha.4` (TestFlight 100700304), 2026-11-22: FAIL, 3 of 3, identical.** A DM
ending in portrait photos: with the keyboard up the last photo's bottom sits 71 pt UNDER the composer's
top edge - the thread rose 176 pt while the composer rose 278 pt. The Android half passes. **The cause is
not established**: two mechanisms fit, and the source cannot choose between them (a pane left 102 pt
above its end - the flag fell, or a scroll write landed elsewhere under WebKit's own scrolling - or a
scroll range that ends short of the padding). No fix is made blind; the next build reports what
separates them:

- the `[CanariIOS] keyboard settled` syslog line now ends with the thread's half: `threadTop`,
  `threadMax`, `threadPad`, `lastRowBottom` (beside `composerTop`). `threadTop` below `threadMax` by ~102
  names the first cause; `threadTop` = `threadMax` with `lastRowBottom` past `composerTop` the second;
- the in-app log says `[ChatArea] left the bottom with no finger on the pane: scrollTop ... (last placed
  ...), N px from the end` on every fall of the stick-to-bottom flag with no finger down - during a rise
  that is the flag read off the engine's move, not the reader's (a reader scrolling up is not logged).

**Owed on the iPhone, on the next `1.7.3` pre-release:** the same DM, keyboard opened three times; copy the
`keyboard settled` lines (syslog) and the in-app log's `left the bottom` lines. The fix follows the line
([chat](../frontend/modules/chat.md#the-flag-is-only-ever-the-readers-2026-11-21)).

**2026-11-21, the iPhone 12 equivalent (the Pixel 6a is the owner's, not touched), `1.7.3-alpha.4`: PARTIAL, a gap on iOS.** A DM ending in three portrait photos (sent from the web peer), opened from the list after the placeholders had settled, composer tapped, three times (WDA taps): the thread **never jumped to older messages and the scroll-down arrow never showed**, and after the keyboard left it was back at its exact last position (every time, same measures). **But with the keyboard up the last photo sat 71 pt BELOW the composer's top edge** (photo bottom y=558 pt, composer top y=487 pt; before, the photo ended 31 pt above the composer at 734 pt vs 765): the thread rose 176 pt while the composer rose 278 pt, so the last row's lower part was hidden behind the composer and the keyboard, and stayed so 3 s later. Step 2 ("the last row stays right above the composer") is therefore not met on the iPhone. Screenshots of the phone: `k5-run1..3-open/closed.png`.
