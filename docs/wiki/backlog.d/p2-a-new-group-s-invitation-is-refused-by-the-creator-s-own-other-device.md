## P2 - a new group's invitation is refused by the creator's own other device: the group is created without the people chosen (2026-11-17)

target: 1.7.0

**Read on the iPhone 12, `1.7.0-alpha.10`, dev** ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)).
`gamma` chose two people in the "Nouvelle discussion" panel (#3793) and kept the suggested label: the
group was created holding `gamma` alone. The iPhone's log: `[GROUP] created an unnamed group;
inviting the 2 person(s) chosen`, then `W [GROUP] an invitation added nobody (add-lock-busy)`. The
server's, in the same second: the creation's own commit admitted `gamma`'s other devices, `gamma`'s
web seat (online) took the group's add lock (`[ADD_LOCK] ... owner=<gamma>:web-... acquired=true
ttl=30s`), and the iPhone's invitation was refused it (`acquired=false`). The panel then read
"Membres (1)", and no notice was on screen 6 s later. The same creation on the Mi 9T, a few minutes
earlier, invited both people.

**Why it is a `1.7.0` defect:** #3793 made creation "create, then invite at once" (`createGroupWithMembers`
in `useConversations`, [chat](../frontend/modules/chat.md#one-new-discussion-panel)). Before it, a
group was created empty and its members added later by hand, so nothing raced the creator's own
newly admitted devices. Any member with a second device online (a phone and a browser) can meet it.

**What a fix must answer, not decided here:** what the creator's other device takes the add lock for
right after its Welcome, and whether it needs to; and why a refused lock on a FIRST invitation ends it
(`notAdded('add-lock-busy')` in `processBulkAddition`) when the owed-invitation path already treats
the same refusal as `waiting` (`replanLostInvitation`, `groupCreation.ts`). The owner's rule of
2026-11-17 holds: creation stays create-then-invite, and a partial invite names who is missing
([decisions](owner-decisions-of-2026-11-17.md#the-evening-the-owner-present)) - an invite that
added NOBODY must say so in those words, never "another member is adding someone" when the other
"member" is the creator's own device.

**Also seen on the same panel (P3, the same build):** choosing a second recent peer right after the
first chose a DIFFERENT person on the iPhone - the first chip appears above the search and pushes the
list down under the finger, the class of row movement #3797 closed for removals
([chat](../frontend/modules/chat.md#a-removal-names-its-member-and-no-remove-control-is-live-while-the-order-is-settling-2026-11-17)).
The name step shows the chips, so the wrong person is visible before the creation.

**Closes with:** the creation on the iPhone 12 with the creator's web seat online, three times, each
inviting everyone chosen; and the same on the Mi 9T.
