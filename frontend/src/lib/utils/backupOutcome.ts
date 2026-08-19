import { BackupError, type BackupErrorCode } from '$lib/backup';
import { m } from '$lib/paraglide/messages';

/**
 * Turns a backup attempt into one sentence the user can read.
 *
 * The layer that refuses a backup classifies WHY, as a {@link BackupErrorCode}; this is the one
 * place that turns a code into words, so a new code is a compile error here rather than a silent
 * fall through to "something went wrong". Kept out of the component because the same outcome has to
 * be reportable from anywhere a backup can be started, and a sentence built inside one `.svelte`
 * file is a sentence the next surface writes again, differently.
 */

/** What happened, and what to say about it. `ok` decides which way the banner is coloured. */
export type BackupOutcome = { ok: boolean; text: string };

/**
 * The sentence for one refusal.
 *
 * Anything that is not a {@link BackupError} reached us unclassified - a bug, a storage write that
 * failed, an out-of-memory - so it gets the generic sentence AND an accusing log line, because an
 * unclassified failure in a path this deliberate is the visible end of something upstream.
 */
export function backupErrorOutcome(e: unknown): BackupOutcome {
  if (!(e instanceof BackupError)) {
    console.error(`[BACKUP] unclassified failure: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, text: m.profile_backup_error_unknown() };
  }
  // The detail is developer-facing and never shown: it names the offending id, count or version.
  console.warn(e.message);
  return { ok: false, text: sentenceFor(e.code) };
}

/** One code, one sentence. Exhaustive: adding a code without a sentence fails to compile. */
function sentenceFor(code: BackupErrorCode): string {
  switch (code) {
    case 'not_a_backup':
      return m.profile_backup_error_not_a_backup();
    case 'too_old':
      return m.profile_backup_error_too_old();
    case 'wrong_key':
      return m.profile_backup_error_wrong_key();
    case 'corrupted':
      return m.profile_backup_error_corrupted();
    case 'too_large':
      return m.profile_backup_error_too_large();
  }
  const unreachable: never = code;
  return unreachable;
}

/**
 * The sentence for a restore that worked.
 *
 * A backup restored onto a DIFFERENT device says so, because the outcome genuinely differs: those
 * conversations arrive read-only and stay that way until the exporting device invites this one back
 * into the MLS groups. A user told only "restored" would read the silence that follows as a bug.
 */
export function backupImportOutcome(result: {
  conversations: number;
  messages: number;
  isSameDevice: boolean;
}): BackupOutcome {
  const counts = { conversations: result.conversations, messages: result.messages };
  return {
    ok: true,
    text: result.isSameDevice
      ? m.profile_backup_import_ok(counts)
      : m.profile_backup_import_ok_other_device(counts),
  };
}

/** The sentence for an export that produced a file. */
export function backupExportOutcome(): BackupOutcome {
  return { ok: true, text: m.profile_backup_export_ok() };
}

/** The sentence for an export that did not. Exports have one failure mode: it did not happen. */
export function backupExportFailure(e: unknown): BackupOutcome {
  console.error(`[BACKUP] export failed: ${e instanceof Error ? e.message : String(e)}`);
  return { ok: false, text: m.profile_backup_error_export() };
}
