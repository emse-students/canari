## P2 - a group call answered into an empty room, and a ring that outlives an outcome-less end

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

**Owed before `group_calls_mode` flips to `mesh` anywhere but dev** (a gate of the flip, review of
#3501, 2026-11-14). Both are invisible while the switch is `off`.

1. **An answer into an empty room sits there, unbounded, microphone open.** A member who taps
   "Rejoindre" after every other participant has left joins a room that holds nobody: the relay
   sends `Joined` and no `PeerReady`, and nothing ever ends the call. The fix is a FACT, not a timer:
   call-service states the other seats on `Joined` (`others: n`, the seats held by other users,
   an away seat counted as held - it may resume), and a client that ANSWERED (never the caller,
   whose room is empty by design until someone answers) ends the call on `others: 0`, with its own
   log line and no missed record. A relay older than the field says nothing, and the client keeps
   today's behaviour, logged as such. Tests: call-service (`Joined` counts, away seat included), the
   client (`others: 0` on an answer ends it; on the caller it does not).
2. **A member's in-app ring survives an answered call that ended.** A ringing member stops only on
   the CALLER's unanswered end (`groupHangupEnds`); when the call was answered and its last two
   participants hang up, their hangups carry no outcome, so a member still ringing keeps ringing
   until the 60 s window closes. The fact that ends it is the room being empty: the LAST
   participant's hangup must say so (a `roomEmpty` flag on the group hangup, set by the device whose
   `closeLeg`/`endCall` leaves no connected leg - the same fact that already sends the ring-end),
   and a ringing member stops on it. Tests: a group call answered by one member, both hang up, a
   third member's ring stops on the last hangup and not on the first.

Mechanism and wire: [calls](../frontend/modules/calls.md#group-calls---the-mesh-client-half-wp-gc2-2026-11-13),
[call-service](../services/call-service.md#the-mesh-wp-gc2-2026-11-13).

_2026-11-20, a pointer:_ the client half of the empty-room fact (WP-GC6) was built on the unmerged local branch `feat/group-calls-wp1` (`frontend/src/lib/services/callRoomOccupancy.ts` with its test, and the WP-GC6 commit that wires it). Read that branch before rebuilding anything; it is behind `main` and needs a merge.
