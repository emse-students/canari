## P2 - a missing seed minted by our own other device is asked of it whether or not it is online

Found reading an Android `1.6.10` log (2026-11-11): the phone asked the owner's own browser for the
seed of a row that browser had minted - the designed choice, `resolveAnswerer` in
`frontend/src/lib/utils/graine/repair.ts` elects the session's sender first, and the sender here is
this very user. The defect is in what "reachable" means for us: for every other member it is
presence (`online`, filtered to devices on the key group's tree), but for ourselves it is
`ownDevicesOnTheGroup` - the server's delivery rows, which say a device of ours JOINED the group,
never that it is online. So with the browser closed the phone still elects itself, names no device
("every device"), sends a transport request nobody receives, marks the session `asked` for the whole
app session, and never falls back to the other members, who all hold the same seed (it was
distributed to the whole key group), nor parks on presence (`parkUntilOnline` is reached only by a
`wait`, which never names ourselves). The row stays unreadable until the next start finds the
browser online.

It did not bite on 2026-11-11: the browser was online and named, and the seed came anyway with the
phone's own backlog ([channel-encryption 4.5](../protocols/channel-encryption.md#45-a-missing-seed-is-requested-and-said-out-loud)).
What the fix needs: ourselves reachable only when `answering` names a device of ours (as `online`
already does for the others), and a presence waiter that can wake on OUR OTHER device coming back -
`whenAnyComesOnline` keys on user ids, and our own user is always "online" through this device, so
it cannot say that today. A test in `repair.test.ts`: own other device on the group but offline, a
second member online - the request goes to that member, not to us.
