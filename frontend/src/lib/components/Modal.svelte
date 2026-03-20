<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';

  interface Props {
    open?: boolean;
    title?: string;
    maxWidth?: string;
    onClose: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let { open = false, title, maxWidth = 'max-w-md', onClose, children, footer }: Props = $props();

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div use:portal class="fixed inset-0 z-[280] pointer-events-none">
    <div
      role="presentation"
      class="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto"
      onclick={handleBackdropClick}
      in:fly={{ duration: 150, y: 8 }}
    >
      <div
        class="bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-2xl w-full {maxWidth} mx-4 overflow-hidden text-text-main"
      >
        {#if title}
          <div class="px-6 py-4 border-b border-cn-border flex items-center justify-between">
            <h2 class="text-base font-semibold text-cn-dark">{title}</h2>
            <button
              onclick={onClose}
              class="p-1.5 rounded-lg hover:bg-cn-bg transition-colors text-text-muted hover:text-cn-dark"
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
  </div>
{/if}
