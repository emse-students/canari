<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';

  interface Props {
    open?: boolean;
    onClose: () => void;
    ariaLabel?: string;
    title?: string;
    onDownload?: () => void;
    showPrev?: boolean;
    showNext?: boolean;
    onPrev?: () => void;
    onNext?: () => void;
    dotCount?: number;
    dotIndex?: number;
    onDotSelect?: (index: number) => void;
    children?: Snippet;
  }

  let {
    open = false,
    onClose,
    ariaLabel = 'Aperçu média',
    title = '',
    onDownload,
    showPrev = false,
    showNext = false,
    onPrev,
    onNext,
    dotCount = 0,
    dotIndex = 0,
    onDotSelect,
    children,
  }: Props = $props();

  const safeAreaPadding =
    'max(0.75rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) max(0.75rem, env(safe-area-inset-bottom)) max(0.75rem, env(safe-area-inset-left))';

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowLeft' && showPrev && onPrev) {
      e.preventDefault();
      onPrev();
    }
    if (e.key === 'ArrowRight' && showNext && onNext) {
      e.preventDefault();
      onNext();
    }
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div use:portal>
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabindex="-1"
      class="fixed inset-0 z-[300] flex flex-col bg-black/95 backdrop-blur-sm text-white"
      style="padding: {safeAreaPadding}; height: 100dvh; width: 100vw;"
    >
      <button
        type="button"
        class="absolute inset-0 z-0"
        onclick={onClose}
        aria-label="Fermer l'aperçu"
      ></button>

      <div class="relative z-10 flex shrink-0 items-center justify-between gap-3 pb-2">
        <p class="min-w-0 flex-1 truncate text-xs sm:text-sm opacity-85">{title}</p>
        <div class="flex items-center gap-2 shrink-0">
          {#if onDownload}
            <button
              type="button"
              class="px-3 h-9 rounded-lg bg-white/15 hover:bg-white/25 transition-colors text-sm font-semibold"
              onclick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
            >
              Télécharger
            </button>
          {/if}
          <button
            type="button"
            class="p-2 rounded-lg bg-white/15 hover:bg-white/25 transition-colors"
            onclick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="Fermer"
          >
            <X size={22} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div class="relative z-10 flex flex-1 min-h-0 w-full items-center justify-center">
        {#if showPrev && onPrev}
          <button
            type="button"
            class="absolute left-0 z-20 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            onclick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            aria-label="Précédent"
          >
            <ChevronLeft size={28} strokeWidth={2.5} />
          </button>
        {/if}

        <div
          role="presentation"
          class="relative z-10 flex h-full w-full max-h-full max-w-full items-center justify-center px-10 sm:px-14"
          onclick={(e) => e.stopPropagation()}
        >
          {@render children?.()}
        </div>

        {#if showNext && onNext}
          <button
            type="button"
            class="absolute right-0 z-20 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            onclick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            aria-label="Suivant"
          >
            <ChevronRight size={28} strokeWidth={2.5} />
          </button>
        {/if}
      </div>

      {#if dotCount > 1 && onDotSelect}
        <div class="relative z-10 flex shrink-0 justify-center gap-1.5 pt-2 pb-1">
          {#each { length: dotCount } as _, i (i)}
            <button
              type="button"
              onclick={(e) => {
                e.stopPropagation();
                onDotSelect(i);
              }}
              class="w-2 h-2 rounded-full transition-all {i === dotIndex
                ? 'bg-white'
                : 'bg-white/40'}"
              aria-label="Image {i + 1}"
            ></button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
