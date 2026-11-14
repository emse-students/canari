## P3 - The add lock is not renewed through a long rebuild chain (review of #2416, 2026-10-25)

target: 1.9.0

An Add takes the server's add lock (`ADD_LOCK_TTL_SEC`, `apps/chat-delivery-service/src/utils/add-lock.ts`)
once, and nothing renews it while `rebuildOnRace` rebuilds. Each rebuild now adds round trips (the
confirmed tree, the premise re-reads), so a long chain can outlive the TTL, and a second Add could
take the lock while the first is still staging. Candidate fixes: renew the lock in each attempt, or
bound the chain by the TTL and surface `add-lock-busy`. Not built.

Re-read 2026-11-11 (batch 12): still real - no renewal exists and `ADD_LOCK_TTL_SEC` is 30. Re-read again 2026-12-11.
