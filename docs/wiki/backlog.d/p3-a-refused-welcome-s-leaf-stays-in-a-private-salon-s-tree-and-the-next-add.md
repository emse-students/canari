## P3 - A refused Welcome's leaf stays in a private salon's tree, and the next Add reads it as "already holds a leaf" (RM-5, `1.4.1-alpha.6`, 2026-10-26)

target: 1.9.0

RM-5 cycle 1: the grant landed before the kick. The granter's Add put the subject's two devices in the
salon's distribution group, and the server refused both Welcomes:

```
[COMMIT] 357b4af8... the gate did not record the admit of <subject>:<device> (not_entitled) - its Welcome is sent and answered as before
[WELCOME] 357b4af8... Welcome REFUSED for <subject>...: the roster does not name its owner - terminal, no longer owed; the leaf it admitted has no seat and the stray sweep collects it
```

That much is designed. But 25 s later (cycle 2) and 2.5 min later (cycle 5), the granter's next grant
to the same subject decided:

```
[21:56:26.961] [GRAINE] ADMIT <subject> into salon 114d3327 of c2886ebf: all 2 device(s) already hold a leaf - no commit
```

The leaves the Welcome never reached were still in the tree, and the Add treated them as members
that need nothing.

**What each person sees, read from this run's consoles:**

- **The granter: nothing.** The panel shows the grant as made (`200`). The refused Welcome is an
  `error` in the console only. The later `already hold a leaf - no commit` is silent.
- **The subject, in this run: the salon appears, then is refused.** Each time the grant reached them
  live, their client logged `Joined channel 114d3327…` and `[CHANNEL] #114d3327… updated -
  canWrite=true`, so the salon shows as writable. The next read of its distribution group answered
  `403`, logged as `this user is NOT entitled to its distribution group (403) - no join is owed and
  no retry can help`, at 21:56:01, 21:56:26 and 21:58:40. Every cycle ended with the kick, so the
  subject was never entitled and nothing was withheld from a member.
- **The case this run did not reach: a grant that stands after a refused Welcome.** Reading
  `ensureJoined` (`graine/distributionGroup.ts`): the subject's device does not hold the group. Its
  seat was never written (the Welcome was refused), so no Welcome is owed to it. Its own door is
  therefore an external commit. Nothing waits on the admitter, so by the code it should self-heal.
  What is unobserved is the outcome of that external commit when the tree already holds a leaf for
  the same device (the duplicate-leaf case that GRP-4 closed for conversations). If the gate refuses
  it, the member has the salon in their list and can never read it: a **P2**.

**The row that decides it: RM-5 with a closing uncontested grant.** After the race cycles, with at
least one cycle where the grant landed first (a refused Welcome), rejoin the subject and grant them
without a kick. Then assert three things within the bound:

- the subject's device is `active` in the salon's distribution group;
- a message sent in the salon is readable on the subject's seat;
- the stale leaf is gone or reused, not duplicated.

**Read on `1.5.0-alpha.2` (2026-10-27): no duplicate.** All five cycles had the grant land first; the closing grant seated both of the subject's devices (`active`, one row each), a salon message reached the subject's seat, and the subject's own roster check counted 8 leaves for 8 active devices. The stale leaf is gone or reused, so the P2 does not arise; this stays a P3 for the two reads below.

To read:

- when the stray sweep runs for a salon group;
- whether `ADMIT ... already hold a leaf` should check the seat (`active`) rather than the leaf.

**Plan (batch 14, 2026-11-12) - the P2 is refuted (the 2026-10-27 reading), two reads left, one change proposed.** (1) Read where the stray sweep runs for a salon's distribution group (`graine/`), and write it beside the seat rule in [channel-encryption](../protocols/channel-encryption.md). (2) Proposed: `ADMIT ... already hold a leaf` decides from the device's seat (`active`) rather than from the leaf, so a leaf no seat holds is re-added and the stale one removed in the same commit. MLS client work: an agent of its own.
