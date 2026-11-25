## P3 - a community history answer relays v1 seeds that every receiver refuses

target: 1.8.1

**Seen 2026-11-24** (a new web device, prod `1.7.3`): six `[GRAINE] REFUSED N v1 seed(s) relayed by
<member> ... a v1 seed is no longer accepted` (4 to 34 seeds each, from three members' up-to-date
devices, the account's own other device among them), and six `[CHANNEL] N message(s) of <salon> are
unreadable and not rendered - v1 session not held`.

**What it is.** Not an old device, and nobody needs telling: `gatherCommunityHistory`
(`utils/graine/frameHandler.ts`) answers a history ask with every session the answerer holds, and every
holder of a pre-`1.0.3` salon still holds its v1 sessions, which stay readable where they are held
([legacy-compatibility](../legacy-compatibility.md), "the Graine v1 reader"). Since the floor `1.0.3`
every receiver refuses a v1 seed that ARRIVES (decided 2026-09-28), so each relayed v1 seed is refused,
on every new device, by design: the salon rows written under v1 (373 rows in 15 salons, 2026-09-02 to
2026-10-09, measured 2026-10-14) are unreadable there for good.

**The noise to remove.** (1) The answerer stops relaying what no receiver accepts: it drops the
sessions with no `v2` block from the seeds it sends, keeping its "I hold nothing" row count honest
(the v1 rows counted on both sides of that comparison). (2) The receiver's `[CHANNEL] ... unreadable`
line for a v1 row is a decided, permanent state: said once per salon at info, naming the decision,
not at warn on every load.

**The tests that close it:** a history answer from a store holding v1 and v2 sessions carries the v2
seeds only, and a store of v1 rows only still answers "I hold nothing"; `channelEventHandler.v1Live.test.ts`
- a v1 row not held is reported once per salon, at info.
