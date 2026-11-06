<script lang="ts">
  import { CircleAlert, CirclePause, CloudOff, LoaderCircle, X } from '@lucide/svelte';
  import Banner from '$lib/components/shared/Banner.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    deleteQueuedPost,
    pauseQueuedPost,
    publishQueueState,
    retryQueuedPost,
  } from '$lib/posts/publishQueue/publishQueue.svelte';
  import { publishViewLabel } from '$lib/posts/publishQueue/publishViewLabel';
  import type { PublishView } from '$lib/posts/publishQueue/publishQueue';

  /**
   * THE DISCREET LINE OF A POST BEING SENT (owner, 2026-11-06: "comme Facebook"). One row per queued
   * post in the app's banner column - in flow, so it covers nothing - with how far the post has
   * gone. While it is sent, a cross PAUSES it (the post is kept); a paused, waiting or stopped post
   * offers Resume or Retry, and Delete - which takes it back everywhere. The queue itself is in
   * `posts/publishQueue/publishQueue.ts`; this only draws `publishQueueState`.
   */

  /** The phases in which the post is being worked on, so the cross pauses it. */
  const WORKING: ReadonlySet<PublishView['phase']> = new Set([
    'queued',
    'preparing',
    'uploading',
    'publishing',
  ]);

  async function remove(view: PublishView) {
    if (!(await showConfirm(m.publish_queue_delete_confirm(), { danger: true }))) return;
    await deleteQueuedPost(view.id);
  }
</script>

{#each publishQueueState.views as view (view.id)}
  <Banner variant={view.phase === 'failed' ? 'warn' : 'neutral'} busy={WORKING.has(view.phase)}>
    {#if view.phase === 'failed'}
      <CircleAlert size={15} class="text-amber-warn shrink-0" aria-hidden="true" />
    {:else if view.phase === 'waiting'}
      <CloudOff size={15} class="shrink-0 opacity-70" aria-hidden="true" />
    {:else if view.phase === 'paused'}
      <CirclePause size={15} class="shrink-0 opacity-70" aria-hidden="true" />
    {:else}
      <LoaderCircle size={15} class="shrink-0 animate-spin opacity-70" aria-hidden="true" />
    {/if}
    <span class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="truncate" data-testid="publish-queue-label">{publishViewLabel(view)}</span>
      {#if view.phase !== 'failed' && view.phase !== 'withdrawing' && view.count > 0}
        <span class="bg-cn-border block h-1 w-full overflow-hidden rounded-full" aria-hidden="true">
          <span
            class="bg-cn-yellow block h-full rounded-full transition-[width] duration-300"
            style:width="{Math.round(view.fraction * 100)}%"
          ></span>
        </span>
      {/if}
    </span>
    {#snippet action()}
      {#if WORKING.has(view.phase)}
        <button
          type="button"
          onclick={() => void pauseQueuedPost(view.id)}
          aria-label={m.publish_queue_pause()}
          title={m.publish_queue_pause()}
          class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-surface shrink-0 rounded-lg"
          data-testid="publish-queue-pause"
        >
          <X size={15} aria-hidden="true" />
        </button>
      {:else if view.phase !== 'withdrawing'}
        <span class="flex shrink-0 gap-2">
          <button
            type="button"
            onclick={() => void retryQueuedPost(view.id)}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-lg px-2.5 py-1 text-xs font-semibold"
          >
            {view.phase === 'paused' ? m.publish_queue_resume() : m.publish_queue_retry()}
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
