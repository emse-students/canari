## Reading owed - the pre-038 link seats the group panel would list as members

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
