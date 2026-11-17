## P3 - the inviter's "join push NOT DELIVERED" line is a warning naming a step that has shipped (2026-11-17)

target: 1.7.0

**Seen on dev `1.7.0-alpha.9`, the phone sitting of 2026-11-17** ([device-verification](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)):
`delta`'s web seat added `gamma` to a group while the iPhone app was not running. The inviter logged,
once per device of the newcomer that was not connected (nine lines for one Add):

```
[JOIN_PUSH] <group>... NOT DELIVERED to <user>:<device> - the server answered its Welcome offline, so no addressed push is sent; it gets no register until the newcomer-asks step ships
```

at `warn`. Six seconds later the iPhone, woken by the Welcome's background push, asked for its
register and the same inviter answered it (`[REGISTER] Answered ...'s register ... (1 nickname(s), sealed)`).

**What is wrong.** The newcomer-asks step is #3777, in this very build: an offline newcomer is now the
ordinary case and is answered by its own ask ([history-answer-addressing](../protocols/history-answer-addressing.md#the-newcomer-asks-for-its-register-2026-11-17)).
So the line is both STALE (it names a future that is past) and LOUD (a warning for an expected path,
repeated for every unconnected device of every newcomer - a member with ten old browser devices writes
ten). Both texts are in `frontend/src/lib/utils/chat/joinPush.ts` (the `offline` branch and the
"gone since" branch).

**The fix:** say what now happens ("no push; the newcomer asks for its register at its next
connection") at `debug`, once per Add with the count of devices, and keep `warn` only for a branch
that has no follow-up. The change touches the line's test in `joinPush.test.ts`.
