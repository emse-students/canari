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
 * BOTH MOBILE APPS, ONE PATH. On iOS the Share Extension's share waits in the App Group until the app
 * carries it over; `read_and_clear_pending_share` does that carry-over before its claim, and
 * `advance_share_epoch` writes the App Group's copy of the epoch the extension stamps - so the same two
 * commands leave nothing there either (`commands/app_group_share.rs`).
 *
 * Kept apart from `incomingShareDrain`, which reaches `media.ts` and through it `stores/auth`, the
 * caller. See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { incomingShare } from '$lib/stores/incomingShare.svelte';
import { discardSharedFiles, parseSharedManifest } from '$lib/mobile/sharedInbox';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { appendLog } from '$lib/utils/sessionLog';

/** Drops the held share and the undrained manifest, and deletes their copies. Never throws. */
export async function eraseIncomingShare(reason: string): Promise<void> {
  incomingShare.drop(reason);
  if (!isMobileTauriRuntime()) return;
  let fenced: number | null = null;
  try {
    fenced = await invoke<number>('advance_share_epoch');
    incomingShare.fence(fenced, reason);
  } catch (error) {
    // FAILS CLOSED: with no new epoch, a share made before this sign-out cannot be told from one made
    // after, so this process offers none again (the native drain refuses one too while the file
    // stays unreadable - `commands/handoff.rs`). Said at the level that accuses.
    console.error(`[SHARE] the share epoch was not advanced (${reason}): ${String(error)}`);
    incomingShare.fence(Number.POSITIVE_INFINITY, reason);
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
  // A capture that STARTED after the advance - in the instant between it and this claim - is the next
  // session's share: handed to the store, whose fence it passes, rather than deleted.
  if (fenced !== null && manifest.epoch >= fenced) {
    appendLog(`[SHARE] a share made after the sign-out (epoch ${manifest.epoch}) kept`);
    incomingShare.offer(
      { text: manifest.text, files: manifest.files, suggested: manifest.target },
      manifest.epoch
    );
    return;
  }
  appendLog(`[SHARE] an undrained share erased (${reason}): ${manifest.files.length} file(s)`);
  await discardSharedFiles(
    manifest.files.map((f) => f.path),
    reason
  );
}
