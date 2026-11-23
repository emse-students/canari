## The owner's decisions of 2026-11-22

Recorded so no question answered here is asked again. Each line names where its detail lives.

1. **A voice note stops other apps' music on iOS, on purpose, as WhatsApp does.** The `1.7.3-alpha.4`
   reading heard the music stop while recording; that is the wanted behaviour, not a defect, and the
   reading row that said "NOT ducked" is corrected
   ([sounds](../frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20),
   [reading](../backlog.d/reading-owed-voice-notes-are-recorded-not-called.md)).
2. **The manual readings are validated as PASS** (owner, 2026-11-22): the rotation of the video, live and camera screens, the iPhone landscape close circle, the live viewer's sound and its landscape reactions, and the Pixel check of #3951. Their entries are deleted ([screen-orientation](../frontend/screen-orientation.md), [device-verification](../device-verification.md)). The FORTIFY entry for the Mi 9T is deleted too: nobody owes it a reading.
3. **A diagnostic trace of row versions is accepted as is** for `1.7.3`: it stays as shipped, with no further work planned.
4. **The anonymous-form tail is at most two small groups** (owner, 2026-11-22): what is left of it is cut into no more than two small pull requests.
5. **THE READINGS RULE** (owner, 2026-11-22, *"comme tu veux"*): a reading the bench can take is taken on the alpha after its fix, or replaced by a test; a reading that can be neither is closed with its reason (the middle clause, asking the owner for a reading that needs his hand, was withdrawn on 2026-11-23: [decisions](owner-decisions-of-2026-11-23.md)). No reading lingers in the backlog. Charter principle 7, simplicity ([principes](../../principes.md)): a list nobody drains hides the work that is real. Rule: [durable-rules](../durable-rules.md#release-and-ci---cicd).
6. **Voice notes get their own playback loudness law** (afternoon answer a): a target of -16 LUFS, with the gain capped at +12 dB. Charter principle 2, the essential is never lost: a quiet voice note must be audible, and the cap keeps a whisper from becoming noise. Planned in [the entry](../backlog.d/voice-notes-have-their-own-playback-loudness-law.md).
7. **A shade reply whose conversation was deleted on the device is SHOWN, never dropped** (afternoon answer b): the conversation is recreated locally and the reply is shown as failed, with Delete. Charter principle 1, your messages are yours, and principle 2: a typed reply never vanishes without a trace. Planned in [the entry](../backlog.d/a-shade-reply-to-a-deleted-conversation-is-shown-as-failed.md); the parked question in [open-questions](../open-questions.md) points here.
8. **The media cache gets a default cap of 500 MB** (afternoon answer c): the Cache Storage bucket `canari-media-ciphertext-v1` is unbounded today. The member chooses 250 MB, 500 MB (default), 1 GB or unlimited. Eviction is LRU and NEVER evicts a sole copy: the server purges ephemeral media after 90 days idle, so an old cached copy may be the only one left. Charter principles 2 and 1, then simplicity. Planned in [the entry](../backlog.d/the-media-cache-has-a-default-cap-of-500-mb.md).
9. **There is no server re-touch before eviction** (afternoon answer d): the client never asks the server to refresh an object's idle stamp to make an eviction safe; the sole-copy rule of decision 8 is decided from what the device knows. Charter principle 4, independence, and the rule that durable state answers only the question it was written for ([CLAUDE.md](../../../CLAUDE.md)).
10. **The personal notepad moves into `/chat` as "Mes notes", a conversation with oneself.** It
   carries text, photos, files and voice notes through the existing encrypted paths
   ([chat](../frontend/modules/chat.md#mes-notes---the-conversation-with-oneself-2026-11-22),
   [chat-delivery](../services/chat-delivery.md#mes-notes---the-self-conversation)).
11. **It is end-to-end MLS, like every conversation.** Charter principle 1 (*vos messages sont a
   vous*) comes before principle 2 (*l'essentiel ne se perd pas*) ([principes](../../principes.md)):
   the server holds nothing it can read. Principle 2 is served by a notice: while the account has a
   single device, the conversation says that losing it loses the notes, and links the `.canari`
   backup ([backup](../frontend/backup.md)).
12. **The existing notepads are migrated into the conversation, then deleted from the server.** Today
   they sit in `users.notesCiphertext` under a key the server holds (`users.notesKey`), which
   principle 1 refuses ([the entry](../backlog.d/mes-notes-notepad-migration-and-retention.md)).
13. **Media keep the normal 90-day idle retention**, and the conversation says so.
14. **Section navigation stays a CLOSED chantier**: this work only REMOVES the notepad entry point,
   it adds no new section ([section-navigation](../frontend/section-navigation.md)).

15. **An answer to an ANONYMOUS form keeps only its WEEK, never its day** (owner, 2026-11-22). If a single respondent answered on a given day, the manager saw a "group of one" for that day and could guess who answered. Charter principle 1, your messages are yours: the date stored beside an answer must not name the person who gave it. The server dates a released batch with the start of its ISO week (Monday 00:00 UTC, `anonymousAnswerWeekSql`), migration 181 cuts the answers already stored (held for the owner's approval line, a backfill of user data), and the manager's list and export show "semaine du 16 nov." ([forms](../frontend/modules/forms.md#an-anonymous-answer-keeps-only-its-week-2026-11-22)). Ships in `1.8.0`.

**Carried out, 2026-11-22 (`1.7.3` shipped):** the four readings entries above and the FORTIFY entry were deleted; every other entry still naming `1.7.3` was retargeted to `1.8.0`, the readings among them, and the readings rule applies to them from the first `1.8.0` alpha ([roadmap](../roadmap.md#log-of-replannings-and-milestones)).
