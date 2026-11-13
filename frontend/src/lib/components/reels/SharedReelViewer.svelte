<script lang="ts">
  import { untrack } from 'svelte';
  import type { PostEntity } from '$lib/posts/api';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { Log } from '$lib/utils/Log';

  /**
   * THE REELS VIEWER OPENED FROM A SHARED LINK (user, 2026-10-23, sharing lot S6): a card that
   * stands for a reel - the generic `LinkPreviewCard` and the chat's `SharedPostCard` - opens the
   * reel in the viewer, started on it and continuing with the others, as Instagram opens a shared
   * reel. ONE implementation for both cards: the viewer is loaded on the first open (most cards are
   * never a reel), with a live token read at that moment.
   */
  interface Props {
    /** The reel to show, or `null` while the viewer is closed. Set on the tap. */
    reel: PostEntity | null;
    /** The caller's log tag, so a line names the card that opened the viewer. */
    logTag: string;
    /** Closes the viewer: the caller sets {@link reel} back to `null`. */
    onClose: () => void;
  }

  let { reel, logTag, onClose }: Props = $props();

  let ReelViewer = $state<typeof import('$lib/components/reels/ReelViewer.svelte').default | null>(
    null
  );
  let authToken = $state('');
  /**
   * The reel the loaded viewer was opened on. Never set back to `null`: the viewer's own props are
   * re-read during its teardown, and an `{#if}` does not guard that read (durable-rules, "AN `{#if}`
   * IS A VISUAL GUARD") - the block is closed by {@link reel} going `null` instead.
   */
  let loadedReel = $state<PostEntity | null>(null);

  /** The effect is keyed on the reel's id, never on the object a refetch may hand in anew. */
  const reelId = $derived(reel?.id ?? null);

  $effect(() => {
    if (!reelId) return;
    const target = untrack(() => reel);
    const tag = untrack(() => logTag);
    if (!target) return;
    let cancelled = false;
    Log.d(tag, `opening the shared reel ${target.id.slice(0, 8)} in the viewer`);
    void Promise.all([getToken(), import('$lib/components/reels/ReelViewer.svelte')])
      .then(([token, mod]) => {
        if (cancelled) return;
        authToken = token;
        ReelViewer = mod.default;
        loadedReel = target;
      })
      .catch((error: unknown) => {
        console.error(`[${tag}] the reels viewer did not open`, error);
        if (!cancelled) onClose();
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if ReelViewer && reel && loadedReel?.id === reel.id}
  <ReelViewer
    startPost={loadedReel ?? reel}
    {authToken}
    likerId={currentUserId() ?? undefined}
    {onClose}
  />
{/if}
