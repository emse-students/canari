## Reading owed - a salon opened on a cold start reads its rows after the key-group drain, with no "unreadable - missing seed" warning (1.6.11 logs, 2026-11-14)

target: 1.7.0

**Built (2026-11-16).** A salon page was decoded while the key group's queue - the frames carrying the
seeds minted while the device was away - was still being drained, so its rows were warned
`unreadable - missing seed` and drawn only by the re-read the drain's end announced: a race that healed
cleanly ([durable-rules](../durable-rules.md)). The verdict "missing" is now ordered after the drain,
and only the rows it concerns wait: while the key group drains (`salonKeysNow`), `loadChannelHistory`
draws every row whose seed the store holds at once and defers - unwarned, unasked - each row whose seed
is missing, decoding those again after the same `whenGroupDrained` proof the seed request waits on,
never a timer ([channel-encryption 4.5](../protocols/channel-encryption.md#45-a-missing-seed-is-requested-and-said-out-loud)).
Pinned by `salonReadGate.test.ts`, `channelCrypto.test.ts` and
`useConversations.salonReadAfterDrain.svelte.test.ts`.

**The reading that closes it**, on a phone, on the `1.7.0` pre-release: leave the app in the
background (or killed) long enough for a member to post in a salon under a NEW seed (another device
posting after a rotation, or a member who never posted there), then cold-start from that salon's
notification. The log must show `[CHANNEL] page of x: n row(s) decoded after key group y... drained` (or no
deferral at all when the drain was already done or every seed was held), **no** `[CHANNEL] n message(s) of x are unreadable ... missing
seed` line for that salon, no `[GRAINE]` request for its seeds, and every row drawn on the first open.
A `missing seed` line that still appears after the `drained` line is a seed this device was never sent:
read it against [the Graine v1 rows warned on every open](p3-salon-rows-warned-unreadable-on-every-open.md)
before reopening this.
