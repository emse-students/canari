## P2 - a replay's bar dragged twice while it loads throws the playhead back to the first target: reading owed
target: 1.7.1

Fixed in code on 2026-11-19 (owner report on a desktop browser): the replay player now gives every seek
a ticket and only the latest may write the playhead; stale downloads are aborted
([rule](../live-replays.md#a-replay-seek-the-latest-target-alone-moves-the-playhead-owner-2026-11-19)).

Owed, a reading on `1.7.1` on dev: a replay opened in a desktop browser, then on the Mi 9T and the
iPhone 12; the bar dragged far, dragged again before the picture arrives, dragged back into the
already-played part, several times quickly. The playhead must stay at the last place dragged to.
Delete this entry when the three readings pass.
