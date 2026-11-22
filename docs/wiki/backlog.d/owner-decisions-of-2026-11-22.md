## The owner's decisions of 2026-11-22

target: 1.7.3

Recorded so no question answered here is asked again. Each line names where its detail lives.

1. **A voice note stops other apps' music on iOS, on purpose, as WhatsApp does.** The `1.7.3-alpha.4`
   reading heard the music stop while recording; that is the wanted behaviour, not a defect, and the
   reading row that said "NOT ducked" is corrected
   ([sounds](../frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20),
   [reading](reading-owed-voice-notes-are-recorded-not-called.md)).
2. **The personal notepad moves into `/chat` as "Mes notes", a conversation with oneself.** It
   carries text, photos, files and voice notes through the existing encrypted paths
   ([chat](../frontend/modules/chat.md#mes-notes---the-conversation-with-oneself-2026-11-22),
   [chat-delivery](../services/chat-delivery.md#mes-notes---the-self-conversation)).
3. **It is end-to-end MLS, like every conversation.** Charter principle 1 (*vos messages sont a
   vous*) comes before principle 2 (*l'essentiel ne se perd pas*) ([principes](../../principes.md)):
   the server holds nothing it can read. Principle 2 is served by a notice: while the account has a
   single device, the conversation says that losing it loses the notes, and links the `.canari`
   backup ([backup](../frontend/backup.md)).
4. **The existing notepads are migrated into the conversation, then deleted from the server.** Today
   they sit in `users.notesCiphertext` under a key the server holds (`users.notesKey`), which
   principle 1 refuses ([the entry](mes-notes-notepad-migration-loss-notice-and-retention.md)).
5. **Media keep the normal 90-day idle retention**, and the conversation says so.
6. **Section navigation stays a CLOSED chantier**: this work only REMOVES the notepad entry point,
   it adds no new section ([section-navigation](../frontend/section-navigation.md)).
