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
import type { SessionContext } from './sessionTypes';

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
    await exportUserBackup({
      storage: ctx.getStorage()!,
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      myDeviceId: ctx.getMyDeviceId(),
      log,
    });
    return backupExportOutcome();
  } catch (e) {
    log(`[BACKUP] Export failed: ${e}`);
    return backupExportFailure(e);
  } finally {
    setIsExporting(false);
  }
}

/**
 * Imports a previously exported backup file, decrypts it with the current PIN,
 * replaces IndexedDB, and reloads conversations.
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
  clearConversations: () => void,
  reloadConversations: () => Promise<void>
): Promise<BackupOutcome | null> {
  if (!ctx.getStorage()) return null;
  setIsImporting(true);
  try {
    const result = await importUserBackup({
      file,
      deviceKeyB64: ctx.getDeviceKey(),
      storage: ctx.getStorage()!,
      myDeviceId: ctx.getMyDeviceId(),
      userId: ctx.getUserId(),
      log,
      clearConversations,
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
