## P2 - "Mes notes": move the old notepads in, state the retention, offer a delete

target: 1.8.3

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

*2026-11-25: moved forward from `1.9.0` to `1.8.2` by the owner ([decisions](../decisions/owner-decisions-of-2026-11-25.md), item 3).*

The conversation itself is built: the server kind `self` (chat-delivery migration 056), the
row, the header, the refusals, the capability that keeps it from older builds, and the single-device
loss notice ([chat](../frontend/modules/chat.md#mes-notes---the-conversation-with-oneself-2026-11-22)).
What the owner decided on 2026-11-22 ([decisions](../decisions/owner-decisions-of-2026-11-22.md)) and is NOT built:

- **The notepad migration.** A client holding a non-empty notepad (`users.notesCiphertext`, under the
  server-held `users.notesKey`) posts it as a first message of "Mes notes", then asks the server to
  delete it. The old routes then answer `410 NOTEPAD_MOVED`, recorded with its removal date in
  [legacy-compatibility](../legacy-compatibility.md). The privacy policy and the Art. 30 register
  ([register](../compliance/register-of-processing.md)) lose the notepad processing in the same
  change.
- **The entry point is removed** only after the migration ships: removing it first would cut access
  to notes that exist (principle 2).
- **The retention line.** The conversation states that media follow the normal 90-day idle retention.
- **Deleting the conversation.** A self row has no settings, so there is no way to delete it from the
  UI yet. The delete must send `?kind=self` (`deleteGroupOnServer(groupId, 'self')`); the server
  refuses any other.

The reading that closes the conversation part: on both phones, write, add a photo and a voice note in
"Mes notes" on one device, read them on the other; on an account with one device, see the loss notice
and follow its link to the backup.
