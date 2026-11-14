## P2 - A forked holder's republished base can send honest members to rung 2 (review of #2269, 2026-10-24, not built)

target: 1.9.0

The commits no person asks for (the leaf refresh, the revoked-leaf removal) are staged only on the
branch the server publishes (`assertOnPublishedBranch`, `publishedBranch.ts`), and a `diverged`
answer - same epoch number, another group context - is read as a FORK of THIS device: the group is
marked in the epoch-gap registry and handed to rung 2 (forget + re-Welcome). That reading trusts the
base. A base minted by the commit gate is trustworthy (stored in the transaction that accepted the
commit), but the holder republish (`putGroupInfo`, `republishStaleBase`) checks only that the epoch
RISES - not that the GroupInfo is on the branch the commit log holds. Scenario: the published base is
stale (a legacy commit, a failed write), a device that forked at epoch E republishes ITS GroupInfo
for E, and the server takes it because E is above the stale epoch. Every honest member at E then
reads `diverged`, accuses itself, and forgets the group for a re-Welcome - while the forked device,
the one actually off the branch, matches the base and keeps going. Owed, in order: a count of
`[FORK]` lines per group on production after #2269 ships (more than one member per group at the same
epoch accuses the base, not the members); then either the server checks a republished base against
the commit log's row for that epoch (its confirmed transcript hash), or a `diverged` is read as
`unproven` (nothing staged, nothing escalated) unless the base was minted by the gate. Code unchanged
in #2269 by decision of the review. Re-read 2026-11-11: unchanged in code; re-read again 2026-12-11. The `[FORK]` count is a production log read, not taken by the triage.

**WIDENED 2026-10-27:** the departed-member removal of a roster diff now goes through the same check
(#2580), and for a KEY GROUP too - its base read from social-service, where a holder also publishes
it. So `diverged` now reaches community and salon key groups, and a forked holder's republished
key-group base would send that key group's honest members to rung 2 the same way. The count owed
above counts `[FORK]` lines on key groups as well.
