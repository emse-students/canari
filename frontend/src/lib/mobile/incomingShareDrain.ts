/**
 * Reads the share the native layer left for the page (`pending_share.json`) into `incomingShare`,
 * and later reads its files when it is staged.
 *
 * Android's `IncomingShare.kt` - and on iOS the Share Extension, whose share the app carries out of
 * the App Group (`commands/app_group_share.rs`) - copies whatever another app shared into the app
 * cache and writes a manifest; `read_and_clear_pending_share` hands that manifest over exactly once. THE COPIES STAY ON
 * DISK until the member has picked a destination and that conversation is displayed: the drain runs
 * at mount, before the PIN, and reading a share's files there would hold them in the WebView for as
 * long as the member takes to unlock and choose. Only `stageSharedFiles` reads them, ONE AT A TIME,
 * each through `take_picked_file`, which also deletes the copy - and a copy the composer would refuse
 * is deleted unread. See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';
import { appendLog } from '$lib/utils/sessionLog';
import { refusedBeforePreparation } from '$lib/media';
import { discardSharedFiles, parseSharedManifest } from '$lib/mobile/sharedInbox';
import { incomingShare, type SharedFileEntry } from '$lib/stores/incomingShare.svelte';

/**
 * Drains a waiting share, if any, into `incomingShare` - its text and the NAMES of its files, no
 * bytes. Returns how many shared items were already lost natively, so the caller can say so; null
 * when nothing was waiting.
 */
export async function drainNativeShare(): Promise<{ lost: number } | null> {
  let pendingShare: { manifest: string; epoch: number | null } | null;
  try {
    pendingShare = await invoke<{ manifest: string; epoch: number | null } | null>(
      'read_and_clear_pending_share'
    );
  } catch (error) {
    console.error(`[SHARE] the native share could not be drained: ${String(error)}`);
    return null;
  }
  if (!pendingShare) return null;
  const manifest = parseSharedManifest(pendingShare.manifest);
  if (!manifest) {
    console.error('[SHARE] the native share manifest is unreadable - dropped');
    return { lost: 1 };
  }
  Log.d(
    'IncomingShare',
    `drained: ${manifest.text.length} chars, ${manifest.files.length} file(s), ${manifest.refused} refused natively, suggestion=${manifest.target !== null}`
  );
  // A CAPTURE THAT STARTED BEFORE A SIGN-OUT belongs to the session that ended: deleted unread,
  // never offered - and not reported, the member who made it is no longer signed in here.
  // AN UNREADABLE EPOCH OFFERS NOTHING: this session's share and the last one's cannot be told
  // apart, and offering the wrong one is the one outcome the erase exists to prevent.
  if (pendingShare.epoch === null) {
    console.error(
      '[SHARE] the share epoch is unreadable - the waiting share is deleted, not offered'
    );
    await discardSharedFiles(
      manifest.files.map((f) => f.path),
      'share epoch unreadable'
    );
    return null;
  }
  if (manifest.epoch < pendingShare.epoch) {
    appendLog(
      `[SHARE] a share from a signed-out session (epoch ${manifest.epoch} < ${pendingShare.epoch}) - deleted`
    );
    await discardSharedFiles(
      manifest.files.map((f) => f.path),
      'captured before a sign-out'
    );
    return null;
  }
  incomingShare.offer(
    { text: manifest.text, files: manifest.files, suggested: manifest.target },
    manifest.epoch
  );
  return { lost: manifest.refused };
}

/** What staging a share's files came to. */
export interface SharedStagingResult {
  staged: number;
  /** Copies that could not be read (a newer share replaced them, the OS purged the cache). */
  lost: number;
  /** Copies over the upload ceiling, deleted unread - the composer would have refused them. */
  tooLarge: SharedFileEntry[];
}

/**
 * Stages a share's files in the composer of `destination` ONE AT A TIME: each copy is read (and deleted) by
 * `take_picked_file`, handed to `stage`, and only then is the next one read - so the WebView holds
 * one shared file's raw bytes at a time, not the whole share. A copy the composer would refuse
 * (`refusedBeforePreparation`, against the server's `limits`) is deleted UNREAD rather than read
 * whole and refused afterwards. Nothing here throws: a copy that cannot be read is counted in `lost`.
 *
 * `stillWanted` is asked before each file: false (a sign-out since the staging began) deletes the
 * rest unread.
 *
 * THE DESTINATION IS READ ONCE, by the caller, and handed to every `stage`: a video re-encode takes
 * seconds, and a destination re-read per file would put the rest of the share in whichever
 * conversation the member opened meanwhile. Each file goes to the conversation they CHOSE, whose
 * composer queue keeps it whether or not it is still on screen.
 */
export async function stageSharedFiles(
  entries: SharedFileEntry[],
  destination: string,
  limits: { maxPlaintextBytes: number } | null,
  stage: (file: File, destination: string) => Promise<void>,
  stillWanted: () => boolean = () => true
): Promise<SharedStagingResult> {
  const result: SharedStagingResult = { staged: 0, lost: 0, tooLarge: [] };
  for (const [index, entry] of entries.entries()) {
    if (!stillWanted()) {
      // A SIGN-OUT since the staging began: the rest of the share is deleted unread, never staged
      // into a session that has ended (`incomingShareSignOut.ts`).
      // Not counted as lost: nobody is signed in to be told.
      const rest = entries.slice(index);
      Log.d('IncomingShare', `staging stopped by a sign-out, ${rest.length} file(s) deleted`);
      await discardSharedFiles(
        rest.map((e) => e.path),
        'signed out during staging'
      );
      break;
    }
    if (refusedBeforePreparation({ type: entry.mime, size: entry.size }, limits)) {
      result.tooLarge.push(entry);
      await discardSharedFiles([entry.path], 'over the upload ceiling');
      continue;
    }
    let file: File;
    try {
      const bytes = await invoke<ArrayBuffer>('take_picked_file', { path: entry.path });
      file = new File([bytes], entry.name, { type: entry.mime, lastModified: Date.now() });
    } catch (error) {
      result.lost++;
      console.error(`[SHARE] a shared file could not be read: ${String(error)}`);
      continue;
    }
    try {
      await stage(file, destination);
      result.staged++;
    } catch (error) {
      result.lost++;
      console.error(`[SHARE] a shared file was read but not staged: ${String(error)}`);
    }
  }
  Log.d(
    'IncomingShare',
    `staged ${result.staged} file(s), ${result.lost} lost, ${result.tooLarge.length} over the ceiling`
  );
  return result;
}
