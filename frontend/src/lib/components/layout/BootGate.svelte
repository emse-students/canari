<script lang="ts">
  import { CloudOff, Loader2 } from '@lucide/svelte';
  import { page } from '$app/state';
  import {
    bootSessionBlocks,
    bootSessionPhase,
    retryBootSession,
  } from '$lib/stores/bootSession.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * What the screen says while the session question is open (`bootSession`): a boot state, then -
   * only if the question got NO answer - an explicit statement that Canari cannot be reached from
   * this network. It covers the shell; the layout does not mount the page underneath.
   */
  const blocked = $derived(bootSessionBlocks(page.url.pathname));
  const unreachable = $derived(bootSessionPhase() === 'unreachable');
</script>

{#if blocked}
  <div
    class="bg-cn-bg text-text-main fixed inset-0 z-(--z-banner) flex flex-col items-center justify-center gap-4 p-6 text-center"
    role="status"
    aria-live="polite"
    data-testid="boot-gate"
  >
    {#if unreachable}
      <CloudOff size={40} class="text-text-muted" aria-hidden="true" />
      <h1 class="text-lg font-bold">{m.boot_unreachable_title()}</h1>
      <p class="text-text-muted max-w-sm text-sm">{m.boot_unreachable_hint()}</p>
      <button
        type="button"
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-lg px-4 py-2 text-sm font-bold"
        onclick={retryBootSession}
      >
        {m.boot_unreachable_retry()}
      </button>
    {:else}
      <Loader2 size={32} class="text-text-muted animate-spin" aria-hidden="true" />
      <p class="text-text-muted text-sm">{m.boot_connecting()}</p>
    {/if}
  </div>
{/if}
