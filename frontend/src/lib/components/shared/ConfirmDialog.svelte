<script lang="ts">
  import { fly } from 'svelte/transition';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { portal } from '$lib/actions/portal';
  import { confirmStore, resolveConfirm } from '$lib/stores/confirm.svelte';

  const pending = $derived(confirmStore.pending);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') resolveConfirm(false);
  }
</script>

<svelte:window onkeydown={pending ? handleKeydown : undefined} />

{#if pending}
  <div use:portal>
    <div
      role="presentation"
      class="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm px-4 pb-[env(safe-area-inset-bottom)]"
      onclick={() => resolveConfirm(false)}
      in:fly={{ duration: 150, opacity: 0 }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={pending.message}
        tabindex="-1"
        use:focusTrap
        class="w-full max-w-sm rounded-2xl bg-[var(--cn-surface)] border border-cn-border shadow-2xl p-6 space-y-5"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        in:fly={{ duration: 200, y: 16 }}
      >
        <p class="text-sm font-medium text-text-main leading-relaxed">{pending.message}</p>
        <div class="flex justify-end gap-2">
          <button
            onclick={() => resolveConfirm(false)}
            class="px-4 py-2 rounded-xl text-sm font-semibold text-text-muted hover:bg-cn-border/40 transition-colors"
          >
            {pending.cancelLabel}
          </button>
          <button
            onclick={() => resolveConfirm(true)}
            class="px-4 py-2 rounded-xl text-sm font-bold transition-colors
              {pending.danger
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-cn-yellow hover:bg-cn-yellow-hover text-cn-dark'}"
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
