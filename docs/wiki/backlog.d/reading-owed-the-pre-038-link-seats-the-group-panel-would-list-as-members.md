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

**The 22 split, 2026-11-14 (read-only):** of the 770 seats not awaiting (0 are flagged
awaiting today), 22 hold no active device of their user in their group:

| Population | Seats | Users | What it is |
| --- | --- | --- | --- |
| No `dm_device_group_memberships` row at all in the group, and the user holds NO KeyPackage device anywhere | 18 | 16 | a departed person's seat (17 joined before 2026-10-24, 1 on 2026-11-01); 11 of the 18 sit in 2-member conversations |
| A row exists, all `pending`, none kicked; the user holds a device | 4 | 1-2 | pending rows from 2026-10-14 (3 of the 4 seats belong to a user with an active device in other groups) |

Neither is a pre-038 link seat of a user who still has devices: the 18 are people with no device left
(the orphan passes revoked hundreds), so a backfill would add devices to nobody; the 4 are pending rows,
a join that never completed. Dev has 0 of 14.

**Owner's decision, 2026-11-14, on dropping the 18: *"Oui, les retirer"*.** The 4 pending seats stay.
Built as **migration 051** (`apps/chat-delivery-service/src/migrations/051_departed_seats_removed.sql`),
**held** (`-- canari:hold-for-owner`), no approval line written. Its allowlist: a seat not awaiting a
member, whose person has no `dm_device_group_memberships` row in the group, none in ANY group, and no
`key_package` row - re-counted on production the same day, read-only: **18 seats, 16 people, 16
conversations** (dev: 0), every one with an open interval and no eviction row. It removes them as a
removal does (under each group's seat lock, the seat generation moved, the interval closed at it),
copies each row whole to `dm_group_members_removed_051` first, logs the counts (never an id), and
carries its rollback, which `051_departed_seats_removed.integration.spec.ts` runs.

**What wrote them, and whether it can again: yes, by design.** The 16 still have an account (one a
session); 13 lost their last device to a revocation, 12 of them in the week of the fourth orphan pass,
3 to the 90-day GC. A conversation seat outlives its person's devices on purpose, so recovery re-invites
a person who returns - nothing wrote these seats wrongly, and the next revocation of a person's last
device leaves the same shape. Changing that costs a returning person every conversation, which is not
reversible, so it is parked as a question
([open-questions](../open-questions.md#decision-owed---should-a-conversation-seat-end-with-its-persons-last-device-2026-11-14)),
not built.

**Owed, in order:** the approval line (owner, or the lead under the 2026-11-03 delegation, after an
adversarial review), the pass on dev through a pre-release (0 rows there: it proves the file runs),
the production NOTICE read at the deploy (`18 matched` expected, fewer if someone came back), then a
migration dropping `dm_group_members_removed_051`, which names people.
