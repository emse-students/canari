<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { X, TriangleAlert, Info, CircleX } from '@lucide/svelte';
  import { toastStore, dismissToast } from '$lib/stores/toast.svelte';

  const toasts = $derived(toastStore.toasts);
</script>

{#if toasts.length > 0}
  <div
    class="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] md:bottom-6 left-4 right-4 md:left-auto md:right-6 md:w-96 z-[60] flex flex-col gap-2 pointer-events-none"
    aria-live="assertive"
    aria-atomic="false"
  >
    {#each toasts as toast (toast.id)}
      <div
        role="alert"
        in:fly={{ y: 16, duration: 200 }}
        out:fade={{ duration: 150 }}
        class="pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-2xl border backdrop-blur-xl shadow-lg
          {toast.type === 'error'
          ? 'bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-400'
          : toast.type === 'warning'
            ? 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400'
            : 'bg-white/80 dark:bg-black/60 border-cn-border text-text-main'}"
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
        <p class="flex-1 text-sm font-medium leading-snug">{toast.message}</p>
        <button
          onclick={() => dismissToast(toast.id)}
          class="shrink-0 mt-0.5 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Fermer"
        >
          <X size={14} />
        </button>
      </div>
    {/each}
  </div>
{/if}
