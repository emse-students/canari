/**
 * THE SAVE BUTTON'S ROAD FOR A LIVE REPLAY (WP-R5): read the whole list, SAY THE SIZE and ask
 * (20 minutes is about 300 MB, owner's design of 2026-11-09), then write it segment by segment
 * (`replaySave.ts`). The rail's `ReelSaveButton` runs it in place of `saveReel`, so the button, its
 * spinner and its gallery-access remedy are the reel's own.
 *
 * Returns the save's outcome like `saveReel`, or `null` when nothing was written - the reader
 * declined the size, or the replay expired between the card and the press (said by a toast).
 */
import { isLiveRefusal } from './api';
import { loadReplayList, saveReplay, type ReplayList, type ReplaySaveResult } from './replaySave';
import { replaySaveMegabytes } from './replayTimeline';
import type { PostEntity } from '$lib/posts/api';
import type { ReelSaveOutcome } from '$lib/reels/saveReel';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';

/** What the flow needs from outside: the list, the question, the write, the toast. */
export interface SaveReplayFlowDeps {
  loadList: (liveId: string) => Promise<ReplayList>;
  confirm: (megabytes: number) => Promise<boolean>;
  save: (list: ReplayList, publishedAt: string) => Promise<ReplaySaveResult>;
  toast: (message: string, kind: 'info' | 'warning' | 'error') => void;
}

const defaultDeps: SaveReplayFlowDeps = {
  loadList: (liveId) => loadReplayList(liveId),
  confirm: (megabytes) =>
    showConfirm(m.replay_save_confirm({ megabytes }), {
      confirmLabel: m.replay_save_confirm_button(),
      cancelLabel: m.replay_save_cancel_button(),
    }),
  save: (list, publishedAt) => saveReplay(list, publishedAt),
  toast: (message, kind) => showToast(message, kind),
};

/** Saves the replay of `post`. @throws the platform's or the network's failure, for the button to say. */
export async function saveReplayFlow(
  post: Pick<PostEntity, 'id' | 'liveId' | 'publishedAt' | 'createdAt'>,
  deps: SaveReplayFlowDeps = defaultDeps
): Promise<ReelSaveOutcome | null> {
  if (!post.liveId) throw new Error(`replay ${post.id} names no live`);
  let list: ReplayList;
  try {
    list = await deps.loadList(post.liveId);
  } catch (e) {
    if (!isLiveRefusal(e, 'not-found')) throw e;
    console.warn(`[LIVE_REPLAY] save ${post.id}: the replay is gone`);
    deps.toast(m.replay_save_gone(), 'warning');
    return null;
  }
  const megabytes = replaySaveMegabytes(list.segments);
  if (!(await deps.confirm(megabytes))) {
    console.debug(`[LIVE_REPLAY] save ${post.id}: ${megabytes} MB declined`);
    return null;
  }
  const result = await deps.save(list, post.publishedAt ?? post.createdAt);
  if (result.parts > 1) deps.toast(m.replay_save_done_parts({ parts: result.parts }), 'info');
  return result.outcome;
}
