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

  // Track whether this modal pushed a history entry so we only close on the
  // matching pop, not on unrelated SvelteKit navigation popstate events.
  let pushedState = false;

  $effect(() => {
    if (open && !pushedState) {
      history.pushState({ canariModal: true }, '');
      pushedState = true;
    } else if (!open) {
      pushedState = false;
    }
  });

  function handlePopState(_e: PopStateEvent) {
    if (!open || !pushedState) return;
    pushedState = false;
    onClose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} onpopstate={handlePopState} />

{#if open}
  <!-- Portal + full-screen backdrop. Using fixed+inset-0 on both layers ensures
       correct coverage even when Tauri's WebView insets are non-zero. -->
  <div use:portal>
    <div
      role="presentation"
      class="fixed inset-0 z-[280] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
      style="padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
      onclick={handleBackdropClick}
      in:fly={{ duration: 200, y: 0, opacity: 0 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabindex="-1"
        class="bg-[var(--cn-surface)] border border-cn-border rounded-t-3xl sm:rounded-2xl shadow-2xl w-full {maxWidth} sm:mx-4 text-text-main flex flex-col max-h-[92dvh]"
        in:fly={{ duration: 220, y: 24 }}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
      >
        {#if title}
          <div class="px-6 py-4 border-b border-cn-border flex items-center justify-between shrink-0">
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
