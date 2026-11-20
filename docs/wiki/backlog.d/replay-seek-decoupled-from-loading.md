## P2 - a replay's bar dragged twice while it loads throws the playhead back to the first target: reading owed
target: 1.7.3

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
