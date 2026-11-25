## P2 - a replay's bar dragged twice while it loads throws the playhead back to the first target: reading owed
target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Fixed in code on 2026-11-19 (owner report on a desktop browser): the replay player now gives every seek
a ticket and only the latest may write the playhead; stale downloads are aborted
([rule](../live-replays.md#a-replay-seek-the-latest-target-alone-moves-the-playhead-owner-2026-11-19)).

Owed, a reading on `1.7.1` on dev: a replay opened in a desktop browser, then on the Mi 9T and the
iPhone 12; the bar dragged far, dragged again before the picture arrives, dragged back into the
already-played part, several times quickly. The playhead must stay at the last place dragged to.
Also in this PR: a replay with a camera flip and a background pause crossed its holes only by luck
(S11's P2, [rule](../live-replays.md#holes-in-the-replay-timeline-crossed-by-construction-s11-2026-11-19)); the reading
is a live that flipped and paused, played from start to end with no touch, on the three devices.
**Read in [S14](../device-verification.md#the-readings-of-2026-11-20-s14-171-alpha6-replays-on-both-phones-messages-on-the-mi-9t-the-reactions-at-two-widths) (`1.7.1-alpha.6`):** desktop (S12 and S14) and the Mi 9T PASS - seeks land in their target's segment, two seeks 40 ms apart land on the second (four pairs on the Mi), and a four-flip live plays from start to end across four holes of 0.7 to 1.8 s with no touch. The iPhone 12 plays that live to its end and its forward drags land; **still owed there: a backward drag and two quick drags** (four backward drags with the WDA gesture did not move the playhead, which is not yet a finding: no log line records a seek on the iPhone, and the drag may not suit the bar). Delete this entry when the iPhone's two drags are read.

**2026-11-22, [I1 sitting](../device-verification.md#the-iphone-12-readings-of-2026-11-22-173-alpha5-the-backup-domains-the-banners-the-reactions-the-replay-bar-the-outage-drill) (`1.7.3-alpha.5`, iPhone 12, a 6:33 replay in the CanaReels viewer, the slider "Position in the video" read from the accessibility tree): FAIL for the backward drag, forward drags PASS.** Forward drags landed (to x=150: 2:36, then to x=260: 4:30, three runs). **A backward drag never moved the playhead**, in four runs with `swipe` and one with an explicit pointer sequence (down, 100 ms pause, four moves, up): from 4:30 a drag to x=60 left it at 4:28 and playback went on; a drag back from 5:11 likewise. The forward drag started from the thumb's own place works, so it is not the thumb grab. The quick pair (forward then backward) could not be judged for the same reason. A leftward touch inside the bar is probably taken by another handler (the viewer's swipe-back), unproven: read `swipeBack.ts` and the bar's pointer handler first. Rotation was not read (WDA cannot turn the phone). Entry stays.

**Cause of the backward drag that did not move on the iPhone (2026-11-22, found in code, engine-agnostic - the clamp is not Safari's):** `VideoPlayer.seekTo` clamped a streamed clip to `buffered.start(0)`; a replay's buffer is a window around the playhead (`ReplayPlayer.trim`), so a leftward drag landed on the window's start (4:30 -> 4:28). Not the swipe-back (the bar is `touch-none`, captures the pointer and stops `pointerdown`). Fixed by `seekAnywhere` on the player, set by `ReplayPane`. Owed: the backward drag re-read on the next alpha, on the iPhone AND on a desktop seat (a drag back of 20 s or more on a replay played 30 s in; the desktop reproduction without the fix was not taken on 2026-11-22: the only dev replay was not served to the seat account, and a fresh one needs a broadcast). `ReplayPlayer` keeps only ten seconds behind the playhead (`LIVE_PLAYER_KEEP_BEHIND_MS`).

**Mi 9T sitting, `1.7.3-alpha.6` (2026-11-22): the backward drag PASSES on Android.** A 393 s replay, real touch drags on the bar
while it played: 63.6 s to 18.1 s (45 s back) and 41 s to 11.5 s (30 s back); each landed, kept playing, and the buffered window
followed the playhead. The iPhone and desktop halves of this entry (and #3963's iOS drag) stay owed, so the entry stays.

**2026-11-22, desktop reading on `1.7.3-alpha.6` (dev, Chrome, a 2:33 replay in the CanaReels viewer): the backward drag PASSES (#3963).** From 67.5 s a pointer drag on "Position dans la video" to 37.5 s (30 s back) landed at 37.4 s and kept playing; from 60.1 s back to 35.1 s (25 s) landed at 35.2 s. The console shows `[VideoPlayer] seek to 57.4 s is before the buffered window - refetched` then `[LIVE_REPLAY] ... seek to 57390 ms -> segment 28` down the drag: the un-clamped path. Taken at 60-67 s into playback, with the buffer window already moving. The iPhone reading is still owed.
