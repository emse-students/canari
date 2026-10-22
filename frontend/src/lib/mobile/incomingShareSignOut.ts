/**
 * ERASES A SHARE INTO CANARI AT SIGN-OUT (user, 2026-10-22): a share waiting in memory or on disk
 * must never land in the account signed in next - a sign-out, and an account switch, which is one.
 *
 * Two places can hold one, and both are emptied:
 * - the page's `incomingShare` (drained, waiting for its destination or for that conversation to
 *   open): dropped, its copies deleted unread (`incomingShare.drop`);
 * - a manifest the native side wrote and the page has not drained yet (`pending_share.json`): it is
 *   CLAIMED through the same command as a drain (`read_and_clear_pending_share`, so a capture racing
 *   it is either claimed here or lands after), and the copies it names are deleted unread.
 * A share whose copies are being STAGED stops at its next file (`stageSharedFiles`, `stillWanted`).
 *
 * Kept apart from `incomingShareDrain`, which reaches `media.ts` and through it `stores/auth`, the
 * caller. See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { incomingShare } from '$lib/stores/incomingShare.svelte';
import { discardSharedFiles, parseSharedManifest } from '$lib/mobile/sharedInbox';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/** Drops the held share and the undrained manifest, and deletes their copies. Never throws. */
export async function eraseIncomingShare(reason: string): Promise<void> {
  incomingShare.drop(reason);
  if (!isAndroidTauriRuntime()) return;
  let raw: string | null;
  try {
    raw = await invoke<string | null>('read_and_clear_pending_share');
  } catch (error) {
    console.error(`[SHARE] the waiting share was not claimed (${reason}): ${String(error)}`);
    return;
  }
  if (!raw) return;
  const manifest = parseSharedManifest(raw);
  if (!manifest) {
    // Its copies stay in the inbox until the next process start sweeps what no manifest names.
    console.error(
      `[SHARE] an unreadable waiting share was claimed (${reason}); its copies wait for the next start`
    );
    return;
  }
  Log.d('IncomingShare', `an undrained share erased (${reason}): ${manifest.files.length} file(s)`);
  await discardSharedFiles(
    manifest.files.map((f) => f.path),
    reason
  );
}
