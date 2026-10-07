<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { fade, fly } from 'svelte/transition';
  import { X, TriangleAlert, Info, CircleX } from '@lucide/svelte';
  import { toastStore, dismissToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  const toasts = $derived(toastStore.toasts);
</script>

{#if toasts.length > 0}
  <!-- PHONE: AT THE TOP. The bottom edge is the composer and the last messages in a conversation
       (the bottom nav is hidden there), so a toast above it covered the very bubble just acted
       on. Below the conversation header when one is open (`--chat-chrome-bottom`, published by ChatArea), else below the safe area. Desktop keeps its corner. -->
  <div
    class="pointer-events-none fixed top-[calc(var(--chat-chrome-bottom,var(--safe-area-inset-top,0px))+0.75rem)] right-4 left-4 z-(--z-toast) flex flex-col gap-2 md:top-auto md:right-6 md:bottom-6 md:left-auto md:w-96"
    aria-live="assertive"
    aria-atomic="false"
  >
    {#each toasts as toast (toast.id)}
      <div
        role="alert"
        in:fly={{ y: -16, duration: 200 }}
        out:fade={{ duration: 150 }}
        class="pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg {toast.type ===
        'error'
          ? 'text-red-err border-red-500/20 bg-red-500/10 dark:text-red-400'
          : toast.type === 'warning'
            ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'border-cn-border text-text-main bg-cn-surface '}"
      >
        <span class="mt-0.5 shrink-0">
          {#if toast.type === 'error'}
            <CircleX size={16} />
          {:else if toast.type === 'warning'}
            <TriangleAlert size={16} />
          {:else}
            <Info size={16} />
          {/if}
        </span>
        <p class="flex-1 text-sm leading-snug font-medium"><EmojiText text={toast.message} /></p>
        <button
          onclick={() => dismissToast(toast.id)}
          class="mt-0.5 shrink-0 opacity-60 transition-opacity hover:opacity-100"
          aria-label={m.common_close_label()}
        >
          <X size={14} />
        </button>
      </div>
    {/each}
  </div>
{/if}
