<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import { fly } from 'svelte/transition';

  interface Props {
    open?: boolean;
    title?: string;
    onClose: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let { open = false, title, onClose, children, footer }: Props = $props();

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div
    role="presentation"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    onclick={handleBackdropClick}
    in:fly={{ duration: 150, y: 8 }}
  >
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
      {#if title}
        <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 class="text-base font-semibold text-cn-dark">{title}</h2>
          <button
            onclick={onClose}
            class="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
            aria-label="Fermer"
          >
            <X size={16} />
          </button>
        </div>
      {/if}

      <div class="px-6 py-4">
        {@render children?.()}
      </div>

      {#if footer}
        <div class="px-6 pb-4 flex justify-end gap-2">
          {@render footer?.()}
        </div>
      {/if}
    </div>
  </div>
{/if}
