## P2 - the web catch-up decrypt session marks frames seen before its state is installed in the live client

target: 1.8.0

Found while building KILL-2 (#2515, the ledgers carried inside the MLS state), not fixed there. The web
catch-up walk decrypts in a session of its own and stages "seen" marks for the frames it read BEFORE
that session's state is installed into the live client. A checkpoint taken in the middle of the walk
can therefore seal marks that are ahead of the ratchet it seals with them; a kill, then a reload,
restores marks for frames the restored ratchet never consumed, and those frames are skipped as read.
The `localStorage` design before #2515 had the same window. The fix is to stage a frame's mark only
once the state that consumed it is the live client's, the same order `persistCheckpoint` already
enforces for a send ([mls-desync-prevention](../protocols/mls-desync-prevention.md)).

A second door to the same window, found by the review of 2026-11-15: when the catch-up's install is
REFUSED (`installUnlessOvertaken` saw a live mutation, `swapClientMonotonic` saw a regression, or
`finalize` threw), the walk's marks stay pending in the shared seen set and the next checkpoint
stages them, while the advance they describe was discarded. The fix above covers it if the marks of
a session are staged only once ITS state was installed, and dropped when it was not.
