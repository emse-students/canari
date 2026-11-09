## P2 - a member added to a group AFTER a nickname was set never shows it (reading 2 of "Modifier les pseudos" FAILED on `v1.6.9-alpha.1`, 2026-11-09) - BUILT (#3185), the re-reading owed

Read on dev: the Mi 9T (inviter, sideloaded `1.6.9` build) and a web client (the invited account, a second signed-in browser profile that already held an MLS device). Entry: [the nicknames readings](p3-modifier-les-pseudos-built-readings-owed.md), item 2.

**What happened.**

1. In a three-member group, the inviter set a nickname on a member from the group's "Modifier les pseudos" screen. The member's iPhone and the inviter showed it with "Defini par ...", and a reset from the iPhone reached the Mi 9T (`canari_nicknames:v1:<account>:<group>` went from the entry to `nickname: null`): reading 1 PASSED.
2. The inviter then added a FOURTH account (the web client) through "Ajouter" in the group's management screen. The group appeared in the new member's list with "A ajoute <name> au groupe".
3. The new member opened the group and the "Modifier les pseudos" screen: **every member read "Definir un pseudo"**, the nicknamed member included, at once and again after 20 s and a full reload of the page. The new member's `localStorage` held **no** `canari_nicknames:v1:*` key at all, while the inviter's held the entry.

**Expected** ([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)): the inviter's JOIN PUSH restates the register, so the first bundle gives the new member the entry as "Defini avant votre arrivee" (`chat_nicknames_set_before_you`), taken by `mergeBundleNicknames` (`systemMessageHandler.ts`, the `[HISTORY_BUNDLE] N nickname(s) taken (unverified)` line).

**The cause, found by reading the three paths end to end (2026-11-09).** None of the three suspects: the
member's "Ajouter" never sent a join push at all. `inviteMembersToGroup` -> `attemptBulkAddition`
(`frontend/src/lib/utils/chat/groupCreation.ts`) staged the commit, registered the newcomer, delivered
the Welcomes (`deliverWelcomes`) and the `memberAdded` notice - and stopped. `sendFullHistoryBundle`, the
join push, was called only from `processPendingInvitations` and `handleWelcomeRequest` (`actions.ts`),
the paths that finish an OWED invitation or answer a device's own request. Since the join push is the
ONE bundle a nickname register is taken from (`mergeBundleNicknames`, review of #3177), a person added
by a member's gesture - the common case, and the join-request approval, which is the same call - never
received one. The reader was right to refuse every other bundle; the writer never wrote this one. The
joiner's later reconciliation answers are addressed answers to its own asks (`addOnly`), which take
messages and nothing else, so nothing repaired it.

**The adversarial review found the same hole on a second path**: the owed-Welcome drain
(`BaseMlsService.deliverOwedWelcomes`) delivers a Welcome whose first send failed, or every Welcome of
an Add whose commit outcome was unknown and accepted later - and pushed nothing either.

**The fix: the push hangs on the delivery of a Welcome, not on a caller.**
`BaseMlsService.sendWelcomeConsuming` - the one place every path's Welcome is known stored - announces
each delivery once (`onWelcomeDelivered`), and `joinPush.ts`, installed with the service, answers it
with one `sendFullHistoryBundle` to that device: once per Welcome from a durable per-account ledger,
queued and never awaited by the gesture, never into a key group. The explicit pushes of the pending
invitation and the welcome_request paths are gone (they would now push twice). Step A holds: the push
is addressed to the device and filtered on its owner's windows, so for a newcomer it carries no
message from before the arrival. Mechanism and cost: [chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08), "The late joiner".

The tests that would have caught it, each failing without the fix: `BaseMlsService.unresolvedCommit.test.ts`
(a settled Add announces each delivered Welcome once, a Welcome whose first send failed is announced
when the drain delivers it, a re-run announces nothing, the Add caller's own send is announced once);
`joinPush.test.ts` (the push carries the register and no message, addressed to the device, and the
newcomer's `mergeBundleNicknames` takes it as "Defini avant votre arrivee"; the same Welcome delivered
again pushes nothing; a later Welcome pushes; no push into a key group; one failing push does not
stop the next).

**Owed: the re-reading on the next pre-release** (`1.6.9-alpha.2` or later). In a group where a member
already holds a nickname, add a FOURTH account through "Ajouter" from a phone on that build; on the new
member, open the group's "Modifier les pseudos": the nicknamed member reads the nickname with "Defini
avant votre arrivee", at once, and `localStorage` holds `canari_nicknames:v1:<new account>:<group>`. The
inviter's exported log carries `[JOIN_PUSH] <group>... join push -> <account>:<device>` then either `Empty
bundle sent ... addressed to ...` or `Full history sent: k of N` with `k` counting only what was sent
since the Add (the inviter's own notice); the web console of the new member `[HISTORY_BUNDLE] 1 nickname(s) taken
(unverified)`.

**2b - the offline newcomer, expected to FAIL until [its own entry](p2-an-offline-newcomer-receives-no-join-push.md) ships.**
The same gesture with the new member's device NOT connected (the app killed, or the browser tab closed)
when "Ajouter" is pressed, then opened a minute later: today the inviter's log reads
`[JOIN_PUSH] <group>... NOT DELIVERED to <account>:<device>` at warn and the new member shows no
nickname. **The join push of #3185 reaches only a device connected when its Welcome is delivered** - an
addressed frame is transport-only and is never queued - and that limit is the next entry, not this one. Remove the account added by the first reading first (or use another one): its device
already holds a leaf, and a fresh add is what is being read. This entry is deleted the day the fix
ships to production.

Test data left on dev by this reading: the web account added to the bench group "nse banc groupe" (no remove path was run).
