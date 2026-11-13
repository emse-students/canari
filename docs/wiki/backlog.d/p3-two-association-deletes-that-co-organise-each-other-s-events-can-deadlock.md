## P3 - Two association deletes that co-organise each other's events can deadlock (found 2026-10-19, review of #2116, not fixed)

target: 1.8.0

**Re-read 2026-11-11: unchanged.** `remove` still locks only its own row (`SELECT 1 FROM
associations WHERE id = $1 FOR UPDATE`).
`AssociationsService.remove(A)` locks A, then deletes A's events. Migration 074's trigger takes their co-owner rows and `coorganise` proposals, and these can name B. The row delete of A then cascades into the co-owner rows and proposals where A co-organises B's events. `remove(B)` does the same in mirror, so each delete can hold a row the other's cascade needs: `40P01`, one delete aborted and retried by hand. This is older than #2116. It needs two staff deleting two linked associations at the same moment. The likely fix is for `remove` to lock, in id order, every association its events' co-organisation reaches before deleting anything. [profiles-and-access](../profiles-and-access.md)
