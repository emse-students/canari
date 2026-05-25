<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { pushHistoryOverlay, closeHistoryOverlayFromUi } from '$lib/utils/historyOverlayStack';
  import { keyboardAwareOverlayPadding } from '$lib/stores/keyboardViewport.svelte';

  interface Props {
    open?: boolean;
    title?: string;
    maxWidth?: string;
    /** When false, backdrop click, Escape, and the header close button are disabled. */
    dismissible?: boolean;
    onClose: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let {
    open = false,
    title,
    maxWidth = 'max-w-md',
    dismissible = true,
    onClose,
    children,
    footer,
  }: Props = $props();

  let historyClose: (() => void) | null = null;

  $effect(() => {
    if (open && !historyClose) {
      historyClose = () => onClose();
      pushHistoryOverlay(historyClose);
    } else if (!open) {
      historyClose = null;
    }
  });

  function dismiss() {
    if (historyClose) {
      closeHistoryOverlayFromUi(historyClose);
    } else {
      onClose();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (!dismissible) return;
    if (e.target === e.currentTarget) dismiss();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!dismissible) return;
    if (e.key === 'Escape') dismiss();
  }
</script>

<svelte:window onkeydown={open && dismissible ? handleKeydown : undefined} />

{#if open}
  <div use:portal>
    <div
      role="presentation"
      data-keyboard-aware-overlay
      class="fixed z-[280] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
      style="padding: {keyboardAwareOverlayPadding}"
      onclick={handleBackdropClick}
      in:fly={{ duration: 200, y: 0, opacity: 0 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabindex="-1"
        use:focusTrap
        class="keyboard-aware-modal-panel bg-[var(--cn-surface)] border border-cn-border rounded-t-3xl sm:rounded-2xl shadow-2xl w-full {maxWidth} sm:mx-4 text-text-main flex flex-col max-h-[92dvh]"
        in:fly={{ duration: 220, y: 24 }}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
      >
        {#if title}
          <div
            class="px-6 py-4 border-b border-cn-border flex items-center justify-between shrink-0"
          >
            <h2 class="text-base font-semibold text-cn-dark">{title}</h2>
            {#if dismissible}
              <button
                onclick={dismiss}
                class="p-1.5 rounded-lg hover:bg-cn-bg transition-colors text-text-muted hover:text-cn-dark"
                aria-label="Fermer"
              >
                <X size={16} />
              </button>
            {/if}
          </div>
        {/if}

        <div class="px-6 py-4 overflow-y-auto flex-1 overscroll-contain">
          {@render children?.()}
        </div>

        {#if footer}
          <div class="px-6 pb-4 flex justify-end gap-2 shrink-0">
            {@render footer?.()}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
