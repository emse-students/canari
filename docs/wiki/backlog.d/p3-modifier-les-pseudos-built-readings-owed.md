## P3 - "Modifier les pseudos" for a group and a community (asked by the user 2026-10-14): built, readings owed

> *"Une fonctionnalite comme sur Messenger : 'Modifier les pseudos', un ecran qui liste les membres du groupe ou de la communaute, avec 'Definir un pseudo' et un crayon a cote de chaque membre."* (not urgent)

**BUILT (2026-11-08), as the user decided it** (2026-10-14: two mechanisms; 2026-10-18: "set by X", a nickname stays when its setter leaves). A DM or group carries a silent `nickname` MLS frame any member may send, restated by the inviter's join push so a late joiner gets it (unverified, members only, dated within the server's time); a community uses three columns on `channel_members` (migration 149) that only a moderator writes - the target may clear their own - re-checked by the server, announced on `workspace.updated`. One resolver override (`displayName.ts` with a scope), never a push, blocks refused or hidden, community nicknames reportable per version. The mechanism, the choices and their limits: [chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08).

**Read on `v1.6.9-alpha.1` (2026-11-09, bench, dev):** 1 PASS (set and reset on a group across the Mi 9T, the iPhone and the member list, each showing "Defini par ..."; the offline third device was not taken); **2 FAIL** ([own entry](p2-a-member-added-after-a-nickname-does-not-receive-it.md)); 3 PASS (a moderator sets a community nickname, the member with the salon open sees the sender label change at once, a plain member sees the screen with no pencil and only a reset on their own row); 4, 5, 6, 7 NOT TAKEN (they need a block, an older build and a report, no bench fixture holds them); 8 NOT TAKEN (a sign-out would have cost the bench's signed-in state). Every nickname set was reset afterwards.

**Owed, on a pre-release (delete this entry when all pass):**

1. Two devices in a group: set, then reset, a nickname - both show it, with who set it, and a third device that was offline converges from the log.
2. A member added to that group AFTER the nickname shows it on first open (the join push restates the register).
3. A community moderator sets a nickname; another member with the salon open sees it live, and a plain member is offered no pencil.
4. The target who blocked the setter does not see their own nickname (group); the server answers `USER_BLOCKED` (community).
5. A build older than this one in the same group and community logs nothing new for the frame and the event.
6. A reported community nickname appears in `/admin/moderation` with its text, and with none once changed.
7. A target who blocked the setter of their nickname in a group sees "a nickname you cannot see is set" on the screen, and its reset clears it for everyone.
8. Sign out, then sign in as another account on the same install: no nickname of the first account's groups is shown, and `canari_nicknames:v1:<first account>:*` is gone from storage.
