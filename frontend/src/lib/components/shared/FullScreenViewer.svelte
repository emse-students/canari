<script lang="ts">
  /**
   * The chrome every full-screen viewer shares: portal, backdrop, card, header and footer.
   *
   * WHY IT EXISTS (WP-VIEWER-1). The image lightbox and the PDF reader do the same job - take over
   * the screen, name what is being shown, offer download and close - and had two independent
   * implementations of every part of it. Two copies of a dialog is not merely duplication: they
   * DRIFT, and the drift is invisible because each looks right on its own. The two found here were
   * an untranslated `aria-label="Fermer"` on one close button beside `m.common_close_label()` on the
   * other, and a `z-[300]` beside a `z-300` - the same intent spelled two ways, one of which a
   * Tailwind 4 upgrade could silently stop honouring.
   *
   * WHAT IT DELIBERATELY DOES NOT OWN: the content area. A photo is one bitmap centred in a box that
   * must never scroll; a PDF is a scrolling column of re-rasterised pages. Handing both a single
   * content wrapper would mean a prop deciding which layout to be, i.e. this component knowing about
   * both - so `children` is rendered as the card's flex child and each viewer brings its own.
   *
   * @see MediaLightbox.svelte, PdfViewerModal.svelte
   */
  import type { Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Announced as the dialog's name; also what a screen reader reads on open. */
    ariaLabel: string;
    onClose: () => void;
    /**
     * What Escape does, when it is not simply "close".
     *
     * The lightbox uses it to unzoom first, so a pinched-in photo takes two presses to dismiss -
     * losing a zoom you meant to keep is cheaper to recover from than losing the whole view.
     */
    onEscape?: () => void;
    /** Tailwind class bounding the card on desktop; full-screen on mobile either way. */
    maxWidthClass?: string;
    /**
     * Suppresses browser touch gestures over the whole card.
     *
     * TRUE only for a viewer that handles every touch itself. The PDF reader must leave it false:
     * its pages live in a real scroll container, and `touch-action: none` would kill the ordinary
     * one-finger scroll that is how a document is read.
     */
    lockTouch?: boolean;
    /** Title, icons, counters - anything left of the action buttons. */
    headerLead?: Snippet;
    /** Viewer-specific buttons, placed before the close button. */
    headerActions?: Snippet;
    children?: Snippet;
    /** Rendered below the content, inside the bottom safe area. */
    footer?: Snippet;
  }

  let {
    ariaLabel,
    onClose,
    onEscape,
    maxWidthClass = 'sm:max-w-[1400px]',
    lockTouch = false,
    headerLead,
    headerActions,
    children,
    footer,
  }: Props = $props();

  const touchStyle = $derived(lockTouch ? 'touch-action: none;' : '');

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    (onEscape ?? onClose)();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- Backdrop: clicking outside the card closes. Escape is handled on the window above. -->
  <div
    role="presentation"
    class="fixed inset-0 z-300 flex items-center justify-center bg-black/70 backdrop-blur-lg sm:p-4"
    style={touchStyle}
    onclick={onClose}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabindex="-1"
      use:focusTrap
      class="relative flex flex-col w-full text-white overflow-hidden
             h-dvh sm:h-[90dvh] {maxWidthClass}
             sm:rounded-xl sm:border sm:border-white/8
             bg-black/20 sm:bg-white/4 sm:backdrop-blur-2xl
             sm:shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
      style={touchStyle}
      onclick={(e) => e.stopPropagation()}
      transition:fly={{ y: 18, duration: 240, easing: cubicOut }}
    >
      <div
        class="flex shrink-0 items-center justify-between gap-3 px-3 sm:px-4 pb-2 sm:pb-3 border-b border-white/8 bg-linear-to-b from-black/30 to-transparent"
        style="padding-top: max(0.75rem, env(safe-area-inset-top, 0.75rem));"
      >
        <div class="flex min-w-0 flex-1 items-center gap-2">
          {@render headerLead?.()}
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          {@render headerActions?.()}
          <button
            type="button"
            class="p-2 rounded-lg bg-white/15 hover:bg-white/25 transition-colors"
            onclick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label={m.common_close_label()}
          >
            <X size={22} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {@render children?.()}

      {#if footer}
        <div
          class="shrink-0"
          style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0.5rem));"
        >
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
</div>
