## P2 - a replay's bar dragged twice while it loads throws the playhead back to the first target: reading owed
target: 1.7.1

Fixed in code on 2026-11-19 (owner report on a desktop browser): the replay player now gives every seek
a ticket and only the latest may write the playhead; stale downloads are aborted
([rule](../live-replays.md#a-replay-seek-the-latest-target-alone-moves-the-playhead-owner-2026-11-19)).

Owed, a reading on `1.7.1` on dev: a replay opened in a desktop browser, then on the Mi 9T and the
iPhone 12; the bar dragged far, dragged again before the picture arrives, dragged back into the
already-played part, several times quickly. The playhead must stay at the last place dragged to.
Also in this PR: a replay with a camera flip and a background pause crossed its holes only by luck
(S11's P2, [rule](../live-replays.md#holes-in-the-replay-timeline-crossed-by-construction-s11-2026-11-19)); the reading
is a live that flipped and paused, played from start to end with no touch, on the three devices.
Delete this entry when the three readings pass.
