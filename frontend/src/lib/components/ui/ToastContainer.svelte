<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { X, TriangleAlert, Info, CircleX } from '@lucide/svelte';
  import { toastStore, dismissToast } from '$lib/stores/toast.svelte';

  const toasts = $derived(toastStore.toasts);
</script>

{#if toasts.length > 0}
  <div
    class="pointer-events-none fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] left-4 z-[60] flex flex-col gap-2 md:right-6 md:bottom-6 md:left-auto md:w-96"
    aria-live="assertive"
    aria-atomic="false"
  >
    {#each toasts as toast (toast.id)}
      <div
        role="alert"
        in:fly={{ y: 16, duration: 200 }}
        out:fade={{ duration: 150 }}
        class="pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur-xl
          {toast.type === 'error'
          ? 'text-red-err border-red-500/20 bg-red-500/10 dark:text-red-400'
          : toast.type === 'warning'
            ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'border-cn-border text-text-main bg-white/80 dark:bg-black/60'}"
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
        <p class="flex-1 text-sm leading-snug font-medium">{toast.message}</p>
        <button
          onclick={() => dismissToast(toast.id)}
          class="mt-0.5 shrink-0 opacity-60 transition-opacity hover:opacity-100"
          aria-label="Fermer"
        >
          <X size={14} />
        </button>
      </div>
    {/each}
  </div>
{/if}
