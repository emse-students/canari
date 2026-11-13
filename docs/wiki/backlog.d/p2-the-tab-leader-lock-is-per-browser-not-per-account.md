## P2 - the tab-leader lock is one per browser, not one per account

target: 1.10.0

`canari-tab-leader` (`tabLeader.ts`) is a single Web Lock for the whole browser profile, so a tab
signed in to account B while a tab of account A leads is a FOLLOWER of a leader that is not its
account's. Since 2026-11-11 a follower writes no MLS state, emits no frame and seals no salon message
itself - it hands them to the leader ([mls-protocol](../protocols/mls-protocol.md#a-follower-tab-wrote-its-copy-of-the-mls-state-over-the-leaders---fixed-2026-11-11)),
and the leader answers a request of another account `not-delegable`. So B's tab can read but not send
and never checkpoints its own state, which no tab of B owns. It is not new (before, B's tab already
had no socket and pulled no queue), only more visible.

Owed: a decision on the lock's scope - one lock per account (`canari-tab-leader.<userId>`) makes each
account's tabs elect their own leader, at the cost of one socket per signed-in account; every
`getTabLeadership` reader and the delegation's account check would be re-read against it. A reading
first: how often two accounts are open in one profile (a `[TAB-COMMIT] ... not-delegable` count).
