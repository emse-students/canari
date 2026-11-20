/**
 * Backup functions extracted from useChatSession: exportBackupImpl, importBackupImpl.
 *
 * Both RETURN their outcome rather than only logging it. The log sink here is the browser console,
 * so for as long as that was the only report, a backup that refused the file was indistinguishable
 * from one that worked - the button went grey, went back, and said nothing either way.
 */
import { exportUserBackup, importUserBackup } from '$lib/utils/chat/actions';
import {
  backupErrorOutcome,
  backupExportFailure,
  backupExportOutcome,
  backupImportOutcome,
  type BackupOutcome,
} from '$lib/utils/backupOutcome';
import type { ChatSessionCallbacks, SessionContext } from './sessionTypes';

/**
 * The restore a backup import asks for once its rows are in the store: the session's own
 * (`loadAndRestoreConversations`), never a clear and a reload - the inbound pipeline keeps running,
 * and a frame meeting a conversation missing from the map in between was handled as one the reader
 * had deleted (review of #3887). A tab with no session callbacks (a follower) restores at its next
 * pass. It may reject; `importUserBackup` says a rejection as the restore's, not the import's.
 */
export function restoreAfterImport(
  sessionCallbacks: () => Pick<ChatSessionCallbacks, 'loadAndRestoreConversations'> | null,
  log: (msg: string) => void
): () => Promise<void> {
  return async () => {
    const cb = sessionCallbacks();
    if (!cb) {
      log('[BACKUP] imported into the store - this tab restores its list at its next restore');
      return;
    }
    await cb.loadAndRestoreConversations();
  };
}

/**
 * Exports an encrypted backup of all conversations and MLS state for the current user
 * (triggers browser download). Sets isExporting flag during the operation.
 *
 * @returns What to tell the user. `null` when there is no store to export - the surface has no
 *   business showing a banner for a button that was never armed.
 */
export async function exportBackupImpl(
  ctx: SessionContext,
  log: (msg: string) => void,
  setIsExporting: (v: boolean) => void
): Promise<BackupOutcome | null> {
  if (!ctx.getStorage()) return null;
  setIsExporting(true);
  try {
    const exported = await exportUserBackup({
      storage: ctx.getStorage()!,
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      myDeviceId: ctx.getMyDeviceId(),
      log,
    });
    // A cancelled save produced no file, so there is no code to show and nothing to report.
    return exported ? backupExportOutcome(exported.recoveryCode, exported.codeOrigin) : null;
  } catch (e) {
    log(`[BACKUP] Export failed: ${e}`);
    return backupExportFailure(e);
  } finally {
    setIsExporting(false);
  }
}

/**
 * Imports a previously exported backup file - opened with its recovery code (v3) or the session's
 * device key (v2) - merges it into the local store, and reloads conversations.
 * Sets isImporting flag during the operation.
 *
 * @returns What to tell the user - which refusal, or how much was restored and onto what. `null`
 *   when there is no store to import into.
 */
export async function importBackupImpl(
  ctx: SessionContext,
  log: (msg: string) => void,
  file: File,
  setIsImporting: (v: boolean) => void,
  reloadConversations: () => Promise<void>,
  recoveryCode?: string
): Promise<BackupOutcome | null> {
  if (!ctx.getStorage()) return null;
  setIsImporting(true);
  try {
    const result = await importUserBackup({
      file,
      recoveryCode,
      deviceKeyB64: ctx.getDeviceKey(),
      storage: ctx.getStorage()!,
      myDeviceId: ctx.getMyDeviceId(),
      userId: ctx.getUserId(),
      log,
      reloadConversations,
    });
    return backupImportOutcome(result);
  } catch (e) {
    log(`[BACKUP] Import failed: ${e}`);
    return backupErrorOutcome(e);
  } finally {
    setIsImporting(false);
  }
}
