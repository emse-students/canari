/**
 * Backup functions extracted from useChatSession: exportBackupImpl, importBackupImpl.
 */
import { exportUserBackup, importUserBackup } from '$lib/utils/chat/actions';
import type { SessionContext } from './sessionTypes';

/**
 * Exports an encrypted backup of all conversations and MLS state for the current user
 * (triggers browser download). Sets isExporting flag during the operation.
 */
export async function exportBackupImpl(
  ctx: SessionContext,
  log: (msg: string) => void,
  setIsExporting: (v: boolean) => void
): Promise<void> {
  if (!ctx.getStorage()) return;
  setIsExporting(true);
  try {
    await exportUserBackup({
      storage: ctx.getStorage()!,
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      myDeviceId: ctx.getMyDeviceId(),
      log,
    });
  } catch (e) {
    // Nothing else reports this: the caller's log sink is the browser console, so a failed export
    // leaves the user with a button that did nothing and this line as its only trace.
    log(`[BACKUP] Export failed: ${e}`);
  } finally {
    setIsExporting(false);
  }
}

/**
 * Imports a previously exported backup file, decrypts it with the current PIN,
 * replaces IndexedDB, and reloads conversations.
 * Sets isImporting flag during the operation.
 */
export async function importBackupImpl(
  ctx: SessionContext,
  log: (msg: string) => void,
  file: File,
  setIsImporting: (v: boolean) => void,
  clearConversations: () => void,
  reloadConversations: () => Promise<void>
): Promise<void> {
  if (!ctx.getStorage()) return;
  setIsImporting(true);
  try {
    await importUserBackup({
      file,
      deviceKeyB64: ctx.getDeviceKey(),
      storage: ctx.getStorage()!,
      myDeviceId: ctx.getMyDeviceId(),
      userId: ctx.getUserId(),
      log,
      clearConversations,
      reloadConversations,
    });
  } catch (e) {
    // Same gap as the export above, and worse: an import that refuses the file looks identical to
    // one that succeeded. See the backlog entry on reporting a backup failure to the user.
    log(`[BACKUP] Import failed: ${e}`);
  } finally {
    setIsImporting(false);
  }
}
