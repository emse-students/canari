## Reading owed - a notification names a member by their nickname in that conversation

target: 1.7.0

Built (owner, 2026-11-14, *"comme sur Messenger, tous les pseudos"*; the device composes every name,
no push carries one): the WebView resolves a notification's sender with the conversation's nickname
scope, and mirrors the nicknames its account may see to `conversation_nicknames.json`, which the
Android FCM service, the iOS extension and `canari_push.mm` read
([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)).
Compiling and the contract tests prove the rule, never a drawn banner. The readings that close it, on a
pre-release, each with the log line that attributes it (`[NOTIF_NAME]`, `[SALON_AUTHOR]`,
`[REACTION_NAME]`, `[CALL_NAME]`, `[NICKNAME_MIRROR]`):

1. **Android, app killed** (Mi 9T): a DM and a group where the sender carries a nickname set by
   somebody else - the banner's title / sender line is the nickname; a member without one keeps the
   profile name.
2. **iOS, app killed** (iPhone 12, the extension): the same two conversations, the title or subtitle
   is the nickname; then with the app alive in the background (`canari_push.mm`).
3. **Community push**: a moderator names a member, the member posts in a salon of that community from
   another device - the line's speaker is the nickname on both phones (a v2 session; a v1 session
   still says "Quelqu'un"), and "X vous a mentionne" on iOS names the nickname.
4. **Block case**: A names B in a group, then B blocks A. On B's Mi 9T the copy holds no entry for B
   in that group (`run-as fr.emse.canari cat conversation_nicknames.json`, the app data directory, or the
   `[NICKNAME_MIRROR]` count), so no notification on B's phone names B by A's nickname; with the
   network off at the session start (block status unknown) it holds none either, and it holds the
   nickname again only once the status answers clear (after an unblock).
5. **Account switch**: account A with nicknames, switch to B on the same install - B's notifications
   never show A's nicknames (`conversation_nicknames.json` names B after B's session starts, or is
   ignored as another account's); sign out of B - the file is gone from the data directory and the
   App Group.
6. **Call ring and reaction**: a caller with a nickname in the call's conversation is named by it on
   the Android ring and on CallKit; a reaction's actor likewise.
