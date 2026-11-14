## P2 - the group panel lists 22 roster seats that hold no device (18 are departed people, 4 are a join that never completed; counted on production 2026-11-14)

target: 1.7.0

**What is built:** the pre-038 link seats the group panel would list as members (found 2026-10-25; the group panel reads `user-members` and drops only `awaitingAdmission` seats)

**The reading that closes it:** ONE read-only production count: roster rows with no active or admitted device of that user in that group. 0 closes it; otherwise a backfill migration (additive, reviewed, backed up just before, owner's rule of 2026-11-01)

**Counted on production 2026-11-14, read-only: 22, not 0.** 22 roster seats (of 770 not awaiting)
hold no `active` or admitted device of their user in their group, 18 of them no device row at all;
18 users, 18 groups, 21 of the 22 joined before 2026-10-24 and one in November. Only 3 of the 22
belong to a user with an active device elsewhere: most are people whose devices are all gone (the
orphan passes revoked hundreds), not link seats from before 038. So the backfill this entry names
would be the wrong repair for most of them: separate the two populations first (a seat whose user
has no device anywhere is a departed device, not a link seat), then decide.

**The 22 split, 2026-11-14 (read-only):** of the 770 seats not awaiting (0 are flagged
awaiting today), 22 hold no active device of their user in their group:

| Population | Seats | Users | What it is |
| --- | --- | --- | --- |
| No `dm_device_group_memberships` row at all in the group, and the user holds NO KeyPackage device anywhere | 18 | 16 | a departed person's seat (17 joined before 2026-10-24, 1 on 2026-11-01); 11 of the 18 sit in 2-member conversations |
| A row exists, all `pending`, none kicked; the user holds a device | 4 | 1-2 | pending rows from 2026-10-14 (3 of the 4 seats belong to a user with an active device in other groups) |

Neither is a pre-038 link seat of a user who still has devices: the 18 are people with no device left
(the orphan passes revoked hundreds), so a backfill would add devices to nobody; the 4 are pending rows,
a join that never completed. Dev has 0 of 14. The repair, if any (drop the 18
roster seats, or leave them), is the owner's decision; nothing was written.

**Triage 2026-11-14 - the reading is DONE, the finding is the entry.** The count the reading asked for read 22, not 0, and the split above shows the repair the old text named (a backfill of devices) is wrong for both populations. What is left is a decision and a fix, not a measurement: (1) the 18 seats of people with no device anywhere are departed seats the group panel (`user-members`, which drops only `awaitingAdmission`) still lists as members - drop them from the panel's list, or reap the seats, owner's call on which (nothing was written); (2) the 4 pending rows from 2026-10-14 are a join that never completed - find why before touching them. Read-only first step: the same split on every estate, then the panel's own filter.
