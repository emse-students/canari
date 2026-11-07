<script lang="ts">
  /**
   * A LIVE'S PREVIEW STILL ON THE FEED CARD (owner, 2026-11-07): the image the broadcaster seals
   * every few segments, opened with the key the list served beside it - no seat taken.
   *
   * Keyed on the poster's NAME: a list refresh that names the same object asks nothing, a new name
   * loads the new still and swaps it in only once it opened, so the card never flashes empty. A load
   * that fails keeps the previous picture (`loadLivePoster` says why); every object URL this made is
   * revoked when replaced and when the card goes.
   */
  import { onDestroy, untrack } from 'svelte';
  import { Radio } from '@lucide/svelte';
  import { loadLivePoster } from '$lib/live/livePosterView';
  import type { LiveListItem } from '$lib/live/types';

  interface Props {
    live: Pick<LiveListItem, 'id' | 'poster' | 'key'>;
    /** The image's accessible description. */
    alt: string;
    /** The loader; the real one unless a test hands its own. */
    load?: typeof loadLivePoster;
  }

  let { live, alt, load = loadLivePoster }: Props = $props();

  let url = $state<string | null>(null);

  const liveId = $derived(live.id);
  const posterName = $derived(live.poster?.name ?? null);

  $effect(() => {
    const name = posterName;
    if (!name) return;
    const item = untrack(() => ({ id: liveId, poster: live.poster, key: live.key }));
    const abort = new AbortController();
    void load(item, abort.signal).then((outcome) => {
      if (abort.signal.aborted || outcome.kind !== 'shown') return;
      const previous = url;
      url = URL.createObjectURL(outcome.image);
      if (previous) URL.revokeObjectURL(previous);
    });
    return () => abort.abort();
  });

  onDestroy(() => {
    if (url) URL.revokeObjectURL(url);
  });
</script>

<div class="bg-cn-scrim relative size-full overflow-hidden" data-live-poster={posterName ?? ''}>
  {#if url}
    <img src={url} {alt} class="size-full object-cover" data-live-poster-image />
  {:else}
    <div class="flex size-full items-center justify-center text-white/60" aria-hidden="true">
      <Radio size={32} />
    </div>
  {/if}
</div>
