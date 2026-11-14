## P2 - A cut holder's add lock ends only by its TTL, and a refused waiter sleeps to it (design after the stable, OFF-3, 2026-10-25)

target: 1.9.0

Two clocks carry normal-path work in the group add lock:

1. **The server's lock TTL** (`ADD_LOCK_TTL_SEC = 30`, `apps/chat-delivery-service/src/utils/add-lock.ts`,
   set with `SET NX EX`). The normal path releases explicitly, by token. But a holder that is CUT
   rather than dead has no way to release, and its owed release (`addLockMarkers.ts`) is sent only
   before ITS OWN next acquire. So for every other member the lock ends by the TTL alone.
2. **The waiter's wake** (`wakeAtAddLockExpiry`, `frontend/src/lib/services/BaseMlsService.ts`). A
   refused acquire with a lost invitation waiting re-plans at the server-stated `PTTL` (bounded by
   `ADD_LOCK_WAIT_BOUND_MS`, `mlsDeliveryApi.ts`), because the holder's release publishes nothing.
   Even when the holder releases after 2 s, the waiter sleeps until about 30 s.
   (Re-read 2026-11-11: `ADD_LOCK_TTL_SEC` is still 30 and the wake unchanged.)

Not clocks on the normal path: the commit lock (`mls:commitlock`, 5 s, released explicitly on
every commit; its TTL is a crash backstop), and the pending pass, which skips a refused lock and
retries at its next pass, event-driven.

**Evidence: OFF-3 on dev, `1.4.1-alpha.4`, times from the server log:**

- `t0`: the committer takes the lock (`acquired=true ttl=30s`) and is cut. No release follows.
- `t0+30 s`: the key expires. Nothing logs it; the test rig sees the key gone after 29.9 s.
- `t0+45 s`: the other member takes the lock, then adds a member and makes two leaf refreshes.
- `t0+64 s`: the committer returns; its kept commit is refused (`epoch_mismatch`).
- `t0+65 s`: its owed release answers `released=false … owed=true`. The lock was long gone.

**Candidate redesign, to design after the stable** (server lock protocol; no new protocol in this
release). The release - explicit, or made by the gateway when the holder's socket closes -
PUBLISHES an event to waiters. The waiter re-plans on that event, and the `PTTL` wake stays only as
a dead-holder backstop.

What the design must keep is the H1 hazard (the original 10 s TTL expired mid-Add and two devices
committed on one epoch). A socket blip mid-Add must not free the lock under a commit still in
flight. The fence that makes a wrongly freed lock harmless is the commit path's epoch check: a
second committer on the same base is refused (`epoch_mismatch` / `concurrent_commit`), never
merged. The design has to show that this fence covers every way a socket-close release can race
an in-flight Add, including the Welcome loop after the accept. Needs an Opus design and security
review.
