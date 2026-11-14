## P3 - Three helpers answer "is this caller a member of this group" (2026-10-25)

target: 1.9.0

`assertCallerActsOnGroup` (`utils/group-membership.ts`) and the private member checks of
`invitations.controller.ts` and `members.controller.ts` (`assertCallerIsGroupMember`,
`assertCallerMayMutateMembership`) each read a caller's standing on a group in their own way. Fold them onto the one kind-aware read (`standingOnGroupOfKind`) with a spec per
route, so a group-keyed route has one answer to the question rather than three.

Re-read 2026-11-11 (batch 12): still real - `assertCallerIsGroupMember` (invitations and members controllers) and `assertCallerMayMutateMembership` are still private copies. Re-read again 2026-12-11.
