/**
 * Fonctions de backup extraites de useChatSession :
 * exportBackupImpl, importBackupImpl.
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
      pin: ctx.getPin(),
      myDeviceId: ctx.getMyDeviceId(),
      log,
    });
  } catch (e) {
    log(`Erreur export : ${e}`);
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
      pin: ctx.getPin(),
      storage: ctx.getStorage()!,
      myDeviceId: ctx.getMyDeviceId(),
      userId: ctx.getUserId(),
      log,
      clearConversations,
      reloadConversations,
    });
  } catch (e) {
    log(`Erreur import : ${e}`);
  } finally {
    setIsImporting(false);
  }
}
