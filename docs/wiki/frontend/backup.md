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

## A seed comes back to READ, never to seal under - 2026-11-15

A Graine session this device minted is its OUTBOUND session: the next message is sealed at
`firstIndex + sentCount` ([channel-encryption](../protocols/channel-encryption.md#213-the-data-model-carries-the-minter-and-its-key-wp-g2-3)).
A backup's count is the one at export, so every message sealed after the export is behind it.
Until 2026-11-15 the import wrote that count back; after a wipe, with the MLS state restored from
the same file, the key group's run still matched the session's anchor, so `graineOutboundVerdict`
answered `reuse` or `redistribute` - both seal at `firstIndex` plus the stale count - and the device sealed again at indices it had already used. The server refuses a
second row under one `(senderSessionId, messageIndex)` (409 `CHANNEL_MESSAGE_KEY_REUSED`), so those
sends failed.

The structural answer: **the file carries no `sentCount`, and the import writes none** (`importBackup`).
`sentCount` is the one fact that makes a session this device's outbound one, so a restored session
is a session the device reads, and the first send after a restore mints a new one. A session the
device still holds is never touched (`importEncryptedGraineRow` is non-destructive), so its live
count stays. Older files still carry the field; it is not read. Pinned by
`backup.graineRestore.test.ts` against the real IndexedDB backend: export, seal past the export,
wipe, import, send.

The same rollback had a second door that no backup opens: two tabs. A tab that lost the lead and had
not yet been told wrote back the count it read before the new leader sent. Closed on 2026-11-17 by
a compare-and-swap on `sentCount` in the write's own transaction, whatever either tab believes about
the lead ([channel-encryption, WP-30](../protocols/channel-encryption.md#wp-30-and-the-departure-nobody-records)).

## What is NOT here

- **Cross-device history is pooled automatically**, as a manifest diff between an account's own
  devices, so the file is for a wipe, a migration or an archive - not for day-to-day sync. See the
  [chat module](modules/chat.md).
- **`SidebarFooterTools.svelte` was a second surface for these two buttons and was deleted on
  2026-08-19** - nothing had imported it. It is named here only so nobody goes looking for it.
