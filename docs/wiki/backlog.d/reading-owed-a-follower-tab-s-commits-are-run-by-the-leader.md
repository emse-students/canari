## Reading owed - a follower tab's commits are run by the leader

target: 1.7.0

**What is built:** a follower tab's commits are run by the leader (#3160, first stable `v1.6.8`; [chat](../frontend/modules/chat.md#a-follower-tabs-commits-are-run-by-the-leader-2026-11-08))

**The reading that closes it:** on dev, two tabs of one account in one desktop browser, both consoles read: each gesture from the follower (group, DM, invite, remove, community, private salon, salon join) logs `handed to the leader tab` / `answered: done` and the leader `run for a follower tab` with the same request id; a conversation created in the follower sends, receives and loads its history with no decrypt failure; the leader closed right after an invite - `leader-gone, NOT run again`, ONE Add; the leader at its PIN keypad - `leader-unavailable`, nothing run; a promotion in place and one during a login (`reloading before going live`); no `CanariDBTabCommit_` record left in IndexedDB, the database gone after an account deletion; no `[TAB-COMMIT]` line at warn or error on an ordinary pass
