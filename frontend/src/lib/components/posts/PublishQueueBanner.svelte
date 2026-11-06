<script lang="ts">
  import { CircleAlert, CloudOff, LoaderCircle } from '@lucide/svelte';
  import Banner from '$lib/components/shared/Banner.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    deleteQueuedPost,
    publishQueueState,
    retryQueuedPost,
  } from '$lib/posts/publishQueue/publishQueue.svelte';
  import { publishViewLabel } from '$lib/posts/publishQueue/publishViewLabel';
  import type { PublishView } from '$lib/posts/publishQueue/publishQueue';

  /**
   * THE DISCREET LINE OF A POST BEING SENT (owner, 2026-11-06: "comme Facebook"). One row per queued
   * post in the app's banner column - in flow, so it covers nothing - with how far the post has
   * gone, and, once it stopped for good, its reason, a Retry and a Delete. The queue itself is in
   * `posts/publishQueue/publishQueue.ts`; this only draws `publishQueueState`.
   */

  async function remove(view: PublishView) {
    if (!(await showConfirm(m.publish_queue_delete_confirm(), { danger: true }))) return;
    await deleteQueuedPost(view.id);
  }
</script>

{#each publishQueueState.views as view (view.id)}
  <Banner
    variant={view.phase === 'failed' ? 'warn' : 'neutral'}
    busy={view.phase !== 'failed' && view.phase !== 'waiting'}
  >
    {#if view.phase === 'failed'}
      <CircleAlert size={15} class="text-amber-warn shrink-0" aria-hidden="true" />
    {:else if view.phase === 'waiting'}
      <CloudOff size={15} class="shrink-0 opacity-70" aria-hidden="true" />
    {:else}
      <LoaderCircle size={15} class="shrink-0 animate-spin opacity-70" aria-hidden="true" />
    {/if}
    <span class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="truncate" data-testid="publish-queue-label">{publishViewLabel(view)}</span>
      {#if view.phase !== 'failed' && view.count > 0}
        <span class="bg-cn-border block h-1 w-full overflow-hidden rounded-full" aria-hidden="true">
          <span
            class="bg-cn-yellow block h-full rounded-full transition-[width] duration-300"
            style:width="{Math.round(view.fraction * 100)}%"
          ></span>
        </span>
      {/if}
    </span>
    {#snippet action()}
      {#if view.phase === 'failed' || view.phase === 'waiting'}
        <span class="flex shrink-0 gap-2">
          <button
            type="button"
            onclick={() => void retryQueuedPost(view.id)}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-lg px-2.5 py-1 text-xs font-semibold"
          >
            {m.publish_queue_retry()}
          </button>
          <button
            type="button"
            onclick={() => void remove(view)}
            class="text-text-muted hover:text-text-main hover:bg-cn-surface rounded-lg px-2.5 py-1 text-xs"
          >
            {m.publish_queue_delete()}
          </button>
        </span>
      {/if}
    {/snippet}
  </Banner>
{/each}
