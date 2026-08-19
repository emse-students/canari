# Backup and restore - the `.canari` file

A user can export every local conversation, message and Graine seed into one encrypted file, and
restore it later on the same device or a second one. The file format, the merge semantics and the
device asymmetry are in the header comment of [`frontend/src/lib/backup.ts`](../../../frontend/src/lib/backup.ts);
this page carries what a reader needs and cannot get from the code alone.

## The shape

| Piece | File | Job |
|---|---|---|
| Format, envelope, merge | `src/lib/backup.ts` | `exportBackup` / `importBackup`, and `BackupError` |
| Orchestration | `src/lib/utils/chat/actions.ts` | reads/writes the store, restores MLS state, reloads |
| Session glue | `src/lib/composables/session/sessionBackup.ts` | flags, and the OUTCOME the surface reports |
| Code -> sentence | `src/lib/utils/backupOutcome.ts` | the only place a refusal becomes words |
| Surface | `src/lib/components/settings/SettingsBackupSection.svelte` | the two buttons and the banner |

## A refusal is a CODE, never a sentence - 2026-08-19

Until 2026-08-19 every refusal in `importBackup` threw an `Error` carrying an English sentence, and
the only reader was `log`, which is `appendLog`, which is `console.log`. **A file the importer
refused and a backup fully restored looked identical on screen**: the button greyed out, came back,
and said nothing either way. Seventeen distinct checks were equally invisible, and an eighteenth -
`JSON.parse` on the decrypted payload - escaped as a bare `SyntaxError` that no caller could tell
from a bug.

Those sentences were English deliberately, which was correct while nothing showed them: a dev-facing
string is English. Giving them a surface is what turns them into user-visible strings, so the two
had to happen in the same change - and the layer that throws still does not write the sentence,
because it cannot know which language the reader has chosen.

`BackupError` therefore carries a `code` from a **closed set** plus an untranslated `detail`:

| Code | What the reader is told | Why it is its own code |
|---|---|---|
| `not_a_backup` | this file is not a Canari backup | the magic header is wrong; the PIN is irrelevant |
| `too_old` | made by too old a version, export a new one | a v1 file is sealed with the PIN, so trying the device key would report a wrong PIN that was never the problem |
| `wrong_key` | wrong PIN, or the file is damaged | the envelope did not open |
| `corrupted` | the backup is damaged | the envelope DID open, so the key was right - this must not read as a wrong PIN |
| `too_large` | too large to restore here | structurally fine, past a cap this client refuses to load |

**The set is what a READER distinguishes, not what the code checks.** Twelve field-level checks all
mean one thing to somebody holding a file - "this is not a readable backup" - and splitting them
further would be a dozen sentences nobody can act on differently. What the developer needs travels
in `detail` (the offending id, the count, the version), straight to the log and never to the screen.
`backupOutcome.ts` switches on the code exhaustively, so a new code that nobody wrote a sentence for
fails to compile rather than falling through to "something went wrong".

**A restore onto a DIFFERENT device says so.** Those conversations arrive `lifecycle: 'pending'` and
stay read-only until the exporting device invites this one back into the MLS groups. A user told
only "restored" would read the silence that follows as a bug.

**Anything that is not a `BackupError` is logged with `console.error`, not `console.warn`.** An
unclassified failure on a path this deliberate is the visible end of something upstream - a storage
write that failed, an out-of-memory - and it gets the generic sentence AND an accusing line.

## What is NOT here

- **Cross-device history is pooled automatically**, as a manifest diff between an account's own
  devices, so the file is for a wipe, a migration or an archive - not for day-to-day sync. See the
  [chat module](modules/chat.md).
- **`SidebarFooterTools.svelte` was a second surface for these two buttons and was deleted on
  2026-08-19** - nothing had imported it. It is named here only so nobody goes looking for it.
