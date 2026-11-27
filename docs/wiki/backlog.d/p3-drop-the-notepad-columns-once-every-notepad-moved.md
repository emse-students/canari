## P3 - drop the three notepad columns of `users` once every notepad has moved

target: 1.9.0

The notepad moved into "Mes notes" in `1.8.2` ([chat](../frontend/modules/chat.md#mes-notes---the-conversation-with-oneself-2026-11-22)):
each account's `users.notes`, `notesCiphertext` and `notesKey` are emptied by its own move
(`UsersService.moveNotes`), and the routes answer `410 NOTEPAD_MOVED` to an account holding none. The
columns themselves stay, because dropping them is destructive and an account that has not signed in
on `1.8.2` or later still holds its notepad there - dropping now would lose it (charter principle 2).

**What lifts it:** a count on production showing no row holding a notepad
(`SELECT count(*) FROM users WHERE COALESCE(NULLIF("notesCiphertext", ''), NULLIF(notes, '')) IS NOT NULL`)
- or the owner's decision about the accounts that never come back. Then a HELD core-service migration
drops the three columns (approval line per [cicd](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)),
the notepad routes and `users/notepad.ts` go with it, and the
[legacy-compatibility](../legacy-compatibility.md) entry is closed. Also drop `notesKey` rows of
accounts that hold a key and no notepad (minted by an older build, never written to).
