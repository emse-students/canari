## P2 - the web catch-up decrypt session marks frames seen before its state is installed in the live client

Found while building KILL-2 (#2515, the ledgers carried inside the MLS state), not fixed there. The web
catch-up walk decrypts in a session of its own and stages "seen" marks for the frames it read BEFORE
that session's state is installed into the live client. A checkpoint taken in the middle of the walk
can therefore seal marks that are ahead of the ratchet it seals with them; a kill, then a reload,
restores marks for frames the restored ratchet never consumed, and those frames are skipped as read.
The `localStorage` design before #2515 had the same window. The fix is to stage a frame's mark only
once the state that consumed it is the live client's, the same order `persistCheckpoint` already
enforces for a send ([mls-desync-prevention](../protocols/mls-desync-prevention.md)).
