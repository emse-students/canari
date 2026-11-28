## P2 - Reading owed - "Mes notes" on both phones, and a profile notepad arriving in it (2026-11-26)

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

**Built, covered by tests, never run on a device** ([chat](../frontend/modules/chat.md#mes-notes---the-conversation-with-oneself-2026-11-22);
owner decisions of 2026-11-22, items 10-14, and 2026-11-25, item 3; charter principles 1 then 2,
[principes](../../principes.md)). The migration's order and idempotence are pinned by unit tests and by
core-service's PostgreSQL integration test; what no test reaches is the real outbox sending into a
real self group on a phone, and the background run at sign-in.

**What to read, on a build carrying the move:**

1. **The move.** On a test account that holds a profile notepad (write one from a build older than
   `1.8.2`, or seed `users.notes` on DEV only), sign in on one phone: "Mes notes" appears (created
   if absent, never opened by itself), holding one message "Votre bloc-notes du profil, déplacé dans
   vos notes :" followed by the notepad; the log shows `[NOTEPAD] notepad moved into "Mes notes" and
   deleted from the server`. Sign in on the second phone: the same message, ONCE.
2. **The old page.** `/profile/me/notepad` lands on the profile hub; the hub lists no notepad.
3. **Both phones** (the reading the 2026-11-22 work already owed): write, add a photo and a voice
   note in "Mes notes" on one phone, read them on the other; on an account with one device, see the
   loss notice and follow its link to the backup; the retention line is under it.
4. **The delete.** "Supprimer mes notes" (the phone menu, the desktop icon) asks first; confirmed,
   the conversation leaves both phones.
