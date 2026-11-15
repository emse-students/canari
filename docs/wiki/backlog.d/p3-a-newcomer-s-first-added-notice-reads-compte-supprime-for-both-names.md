## P3 - a newcomer's thread reads "Compte supprime a ajoute Compte supprime au groupe" for its own Add

target: 1.7.0

Found by the web sitting of 2026-11-15 on dev (`1.6.12-alpha.2`, build `dd9053e4e`, which carries #3574's "a malformed id is never a deleted account"), web, French UI. A member made a one-member group, an outsider followed its link, the member accepted the ask (11 devices admitted at epoch 2). On the newcomer's seat the group's list preview read "Canari Test Gamma a ajoute Canari Test Alpha au groupe", but the thread's own notice read "Compte supprime a ajoute Compte supprime au groupe", and kept reading so after two reloads. The client log says why it is not a lookup that failed: `GET /api/users/batch` answered 200 and `[DISPLAYNAME] no such user - the server answered it is gone` was written twice, once per name, each time the thread opened (the server did NOT log a malformed id).

**Not known:** which two ids the notice carries (the DOM holds none), and whether the notice written on the newcomer's own device from the Welcome carries something other than the two account ids (a device id, a prefix, another case). `noticeDisplayText` draws from the ids when every name is known, else shows the stored sentence, so the stored sentence is the one on screen. Read the row's `NoticeSpec` on the newcomer's store first, then fix where it is written.

**Reading that closes it:** repeat the link-and-accept on the next pre-release; the thread must name both people; the row's ids resolve through `/api/users/batch` as `found`. Related: [chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08) (the same Add, nicknames).
