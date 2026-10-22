/**
 * ERASES A SHARE INTO CANARI AT SIGN-OUT (user, 2026-10-22): a share waiting in memory or on disk
 * must never land in the account signed in next - a sign-out, and an account switch, which is one.
 *
 * Two places can hold one, and both are emptied:
 * - the page's `incomingShare` (drained, waiting for its destination or for that conversation to
 *   open): dropped, its copies deleted unread (`incomingShare.drop`);
 * - a manifest the native side wrote and the page has not drained yet (`pending_share.json`): it is
 *   CLAIMED through the same command as a drain (`read_and_clear_pending_share`), and the copies it
 *   names are deleted unread.
 * And what neither can see is closed by an ORDER, the share EPOCH (`commands/handoff.rs`): the
 * erase ADVANCES it, so a copy still running natively - started before this sign-out, so this
 * account's - writes a manifest every later drain finds stale and deletes; and it FENCES the store
 * at it, so a drain that claimed its manifest before the sign-out cannot offer it afterwards.
 * A share whose copies are being STAGED stops before each file and after each one is prepared
 * (`stageSharedFiles` and `handleFilesSelected`, `stillWanted` on the sign-out generation).
 *
 * Kept apart from `incomingShareDrain`, which reaches `media.ts` and through it `stores/auth`, the
 * caller. See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { incomingShare } from '$lib/stores/incomingShare.svelte';
import { discardSharedFiles, parseSharedManifest } from '$lib/mobile/sharedInbox';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { appendLog } from '$lib/utils/sessionLog';

/** Drops the held share and the undrained manifest, and deletes their copies. Never throws. */
export async function eraseIncomingShare(reason: string): Promise<void> {
  incomingShare.drop(reason);
  if (!isAndroidTauriRuntime()) return;
  try {
    incomingShare.fence(await invoke<number>('advance_share_epoch'), reason);
  } catch (error) {
    // The held share and the waiting manifest still go below; what is NOT closed is a copy still
    // running natively, and a drain racing this one - said, at the level that accuses.
    console.error(`[SHARE] the share epoch was not advanced (${reason}): ${String(error)}`);
  }
  let pendingShare: { manifest: string } | null;
  try {
    pendingShare = await invoke<{ manifest: string } | null>('read_and_clear_pending_share');
  } catch (error) {
    console.error(`[SHARE] the waiting share was not claimed (${reason}): ${String(error)}`);
    return;
  }
  if (!pendingShare) return;
  const manifest = parseSharedManifest(pendingShare.manifest);
  if (!manifest) {
    // Its copies stay in the inbox until the next process start sweeps what no manifest names.
    console.error(
      `[SHARE] an unreadable waiting share was claimed (${reason}); its copies wait for the next start`
    );
    return;
  }
  appendLog(`[SHARE] an undrained share erased (${reason}): ${manifest.files.length} file(s)`);
  await discardSharedFiles(
    manifest.files.map((f) => f.path),
    reason
  );
}
