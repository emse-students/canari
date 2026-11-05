<script lang="ts">
  import { CloudOff, Loader2 } from '@lucide/svelte';
  import { page } from '$app/state';
  import {
    bootSessionBlocks,
    bootSessionPhase,
    noteSessionKnownElsewhere,
    retryBootSession,
  } from '$lib/stores/bootSession.svelte';
  import { sessionAnsweredFor } from '$lib/stores/sessionAnswer.svelte';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * What the screen says while the session question is open (`bootSession`): a boot state, then -
   * only if the question got NO answer - an explicit statement that Canari cannot be reached from
   * this network. It covers the shell; the layout does not mount the page underneath and makes the
   * shell `inert`, so Tab cannot reach what the screen hides.
   *
   * ONLY THE ONE-LINE STATE IS A LIVE REGION: a heading and a button inside `aria-live` are
   * re-announced as a block. Focus moves to Retry when the network cannot be reached, because a
   * keyboard or screen-reader user has nothing else to reach.
   */
  const blocked = $derived(bootSessionBlocks(page.url.pathname));
  const unreachable = $derived(bootSessionPhase() === 'unreachable');
  let retryButton = $state<HTMLButtonElement | null>(null);

  // A session known by another road (another caller's refresh answered, the unlock completed) ends
  // the question: the screen must not outlive the fact it was waiting for.
  $effect(() => {
    if (bootSessionPhase() === 'settled') return;
    if (sessionAnsweredFor() || globalSession.isLoggedIn) noteSessionKnownElsewhere();
  });

  $effect(() => {
    if (blocked && unreachable) retryButton?.focus();
  });
</script>

{#if blocked}
  <div
    class="bg-cn-bg text-text-main fixed inset-0 z-(--z-banner) flex flex-col items-center justify-center gap-4 p-6 text-center"
    data-testid="boot-gate"
  >
    {#if unreachable}
      <CloudOff size={40} class="text-text-muted" aria-hidden="true" />
      <p class="text-lg font-bold" role="status" aria-live="polite">
        {m.boot_unreachable_title()}
      </p>
      <p class="text-text-muted max-w-sm text-sm">{m.boot_unreachable_hint()}</p>
      <button
        bind:this={retryButton}
        type="button"
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-lg px-4 py-2 text-sm font-bold"
        onclick={retryBootSession}
      >
        {m.boot_unreachable_retry()}
      </button>
    {:else}
      <Loader2 size={32} class="text-text-muted animate-spin" aria-hidden="true" />
      <p class="text-text-muted text-sm" role="status" aria-live="polite">
        {m.boot_connecting()}
      </p>
    {/if}
  </div>
{/if}
