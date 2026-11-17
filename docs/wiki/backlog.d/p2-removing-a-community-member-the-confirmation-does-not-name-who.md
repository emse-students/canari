## P2 - removing a community member: the confirmation does not name who, and a removal aimed at one member removed another on the bench (2026-11-17)

target: 1.7.1

**Seen on dev `1.7.0-alpha.9`, the phone sitting of 2026-11-17**
([device-verification](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)):
`delta`'s web seat (the community's admin) removed `beta` through the rig's `removeCommunityMember`
(`tools/cross-client-harness/comm.mjs`: mark the row naming the member, click its remove button by
coordinates, confirm). The members panel was still filling in ("Chargement des membres..." a moment
before). The server and the key group then removed **`alpha`**, not `beta`: `delta`'s console
`[GRAINE] REMOVE community <id>: <alpha> kicked from the community - committing it from this device`
and `[TRUST] ... <alpha> left the tree (last leaf removed)`, while the rig's own read-back still listed
`beta` among the members. **Four times out of four**, it was the first removal after `alpha` had been
invited back; the 40 removals made while `alpha` was not a member each removed `beta`. Then the
removal was done by a DOM `click()` on the button inside `beta`'s own row instead of a click at its
coordinates, and the first removal after `alpha`'s next invitation removed `beta`. So the mechanism
is read, not guessed: the roster is sorted by name, `alpha`'s row is drawn after `beta`'s once its
profile lookup settles, lands ABOVE it, and the click at the coordinates `beta`'s button had a moment
before hits `alpha`'s.

**What is wrong in the product, whatever the click did.** The dialog says only
"Retirer ce membre de la communaute ? Il sera retire de tous les canaux."
(`chat_community_remove_member_confirm`, `SidebarCommunityAdminPanel.svelte`), so a person whose tap
lands on the wrong row - the roster reorders as each member's profile lookup settles
(`orderedMembers`, keyed by `userId`) - confirms a removal without being told whose. The rows are
keyed, so a marked row keeps its member; what moved was the row under a pointer, which a finger meets
as well as the rig.

**The fix:** name the member in the confirmation (`{name}` in the message, both locales), and do not
draw a row's remove control until the roster's order is final. The rig's `removeCommunityMember`
should also assert, from the confirmation's text, that it is removing whom it was asked to.
