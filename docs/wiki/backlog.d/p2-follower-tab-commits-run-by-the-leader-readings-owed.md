## P2 - a follower tab's commits are run by the leader: built 2026-11-08, the two-tab readings on dev owed

The follower-tab banner is gone and a follower hands creating a group or a direct conversation,
inviting, removing, and entering a community's or a salon's key group to the leader tab, which runs
them on its own state and answers ([chat](../frontend/modules/chat.md#a-follower-tabs-commits-are-run-by-the-leader-2026-11-08),
[mls-protocol](../protocols/mls-protocol.md#a-follower-tab-hands-its-commits-to-the-leader-2026-11-08)).
Unit-guarded (`tabCommitDelegation.test.ts`); nothing has run it in two real tabs yet. Owed on dev,
two tabs of one account in one desktop browser, the console of BOTH read:

1. **Each gesture from the follower** (create a group, start a DM, invite, remove, create a community,
   create a private salon, join a salon): the follower logs `handed to the leader tab` and
   `answered: done`, the leader `run for a follower tab` with the SAME request id;
   the follower draws and selects a created conversation, and its member list follows an invite or
   a removal.
2. **A conversation created from the follower, then used there**: a message sent from the follower
   reaches the peer, a peer's reply appears in the follower, and its history load logs
   `not held by this follower tab's copy` with no decrypt failure.
3. **The leader closed mid-gesture** (close the leader tab right after pressing invite in the
   follower): the follower is told the main tab closed, its log says `leader-gone, NOT run again`
   from the tab that takes the lead, and the group holds ONE Add, never two.
4. **The leader at its PIN keypad** (lock the leader, then invite from the follower): the follower is
   told at once that the main tab is not ready, the leader logs `leader-unavailable`, nothing runs.
5. **A promotion in place** (close the leader with a request pending from a third tab): the promoted
   tab logs nothing for it before its reload, and its reloaded successor logs `run for a follower tab`.
6. **A promotion during a login** (reload the follower, close the leader while the follower's PIN
   unlock runs): the follower logs `reloading before going live` and comes back as the leader.
7. **IndexedDB holds no `CanariDBTabCommit_` record** after 1 to 5 (DevTools, Application), and the
   database is gone after a sign-out with account deletion.
8. **No `[TAB-COMMIT]` line at warn or error** on an ordinary pass of 1 and 2.
