## P2 - a member added to a group AFTER a nickname was set never shows it (reading 2 of "Modifier les pseudos" FAILED on `v1.6.9-alpha.1`, 2026-11-09)

Read on dev: the Mi 9T (inviter, sideloaded `1.6.9` build) and a web client (the invited account, a second signed-in browser profile that already held an MLS device). Entry: [the nicknames readings](p3-modifier-les-pseudos-built-readings-owed.md), item 2.

**What happened.**

1. In a three-member group, the inviter set a nickname on a member from the group's "Modifier les pseudos" screen. The member's iPhone and the inviter showed it with "Defini par ...", and a reset from the iPhone reached the Mi 9T (`canari_nicknames:v1:<account>:<group>` went from the entry to `nickname: null`): reading 1 PASSED.
2. The inviter then added a FOURTH account (the web client) through "Ajouter" in the group's management screen. The group appeared in the new member's list with "A ajoute <name> au groupe".
3. The new member opened the group and the "Modifier les pseudos" screen: **every member read "Definir un pseudo"**, the nicknamed member included, at once and again after 20 s and a full reload of the page. The new member's `localStorage` held **no** `canari_nicknames:v1:*` key at all, while the inviter's held the entry.

**Expected** ([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)): the inviter's JOIN PUSH restates the register, so the first bundle gives the new member the entry as "Defini avant votre arrivee" (`chat_nicknames_set_before_you`), taken by `mergeBundleNicknames` (`systemMessageHandler.ts`, the `[HISTORY_BUNDLE] N nickname(s) taken (unverified)` line).

**Suspected causes, none verified** (no log of either side was read - the Mi 9T release build keeps its `Log.d` out of logcat and the web console was not captured at the join):

- the join push was never built for this Add path (an "Ajouter" from a phone, a new member whose device was already known), or was built without `nicknames` because the register held only a reset-free entry the sender considered covered by another path;
- the bundle arrived and `mergeBundleNicknames` refused it: its target-in-tree check (`getGroupMemberIdentities`) answers an unreadable tree during the join, which refuses the whole register (a race between the Welcome and the bundle);
- step A of [the new member receives no past](../backlog.md#p1---a-new-member-of-a-group-conversation-receives-its-whole-past-decided-2026-10-21-that-they-must-not) withholds the whole bundle, the register included, from a member who has no history to receive.

**To do.** Reproduce with the console of the new member captured from before the Add (`[HISTORY_BUNDLE]` lines and any `nickname` refusal), and the inviter's log exported from Settings; then decide which of the three it is. The test that would have caught it: an integration test of the join push of a group whose register is non-empty, asserting the first bundle carries it, on the real Add path and not on the bundle builder alone.

Test data left on dev by this reading: the web account added to the bench group "nse banc groupe" (no remove path was run).
