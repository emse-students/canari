<script lang="ts">
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
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
   * TWO FRAMES, ONE SHELL. The PDF reader keeps the card: a column of pages needs its header in the
   * flow, above the text it would otherwise cover. The photo viewer is `immersive`, the frame
   * MiGallery's viewer copied from Google Photos: black edge to edge at every width, no card, and
   * the bars floating OVER the picture on a flat translucent black, hidden together by a tap
   * (`chromeHidden`), with Back on the left where the platform puts it.
   *
   * @see MediaLightbox.svelte, PdfViewerModal.svelte
   */
  import type { Snippet } from 'svelte';
  import { ArrowLeft, X } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { fade, fly } from 'svelte/transition';
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
    /** Full-screen black at every width, bars floating over the content (the photo viewer). */
    immersive?: boolean;
    /** Immersive only: the bars are faded out and let every touch through to the content. */
    chromeHidden?: boolean;
    /**
     * Immersive only: how opaque the black ground is, in `[0, 1]`. The swipe-down dismiss fades it
     * as the picture follows the finger, so what is behind shows the gesture is a way out.
     */
    backdropOpacity?: number;
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
    immersive = false,
    chromeHidden = false,
    backdropOpacity = 1,
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
  <!--
    Backdrop: clicking outside the card closes. Escape is handled on the window above.

    OPAQUE, AND THAT IS THE WHOLE POINT OF A VIEWER (user, 2026-09-10: *"la visionneuse qui s'ouvre
    a un fond transparent, ce qui n'est pas genial"*). It was `bg-black/70`, so three tenths of the
    feed carried on showing through the one surface whose job is to leave nothing else on screen -
    a photograph was then read against whatever happened to be behind it, and its own colours were
    the thing that suffered. `cn-scrim` is the token for exactly this: a surface deliberately dark
    in BOTH themes, already carrying the call and video chrome, so the viewer stops inventing its
    own black. The card above it keeps its translucency, which now reads as elevation over an
    opaque ground rather than as a window.

    The fade is what an opaque backdrop owes: appearing in one frame is a flash, and the card's own
    `fly` is 240ms, so the ground must not land after the thing standing on it.
  -->
  <div
    role="presentation"
    use:coversScreen
    class="fixed inset-0 z-(--z-viewer) flex items-center justify-center {immersive
      ? ''
      : 'bg-cn-scrim sm:p-4'}"
    style="{touchStyle}{immersive ? `background-color: rgb(0 0 0 / ${backdropOpacity});` : ''}"
    onclick={onClose}
    transition:fade={{ duration: 160 }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabindex="-1"
      use:focusTrap
      class="relative flex h-dvh w-full flex-col overflow-hidden text-white {immersive
        ? ''
        : `sm:h-[90dvh] ${maxWidthClass} bg-black/20 sm:rounded-xl sm:border sm:border-white/8 sm:bg-white/4 sm:shadow-[0_20px_60px_rgba(0,0,0,0.7)]`}"
      style={touchStyle}
      onclick={(e) => e.stopPropagation()}
      transition:fly={{ y: 18, duration: 240, easing: cubicOut }}
    >
      <!--
        Immersive: the bar floats over the picture on a FLAT translucent black - no blur, no
        gradient (the flat rule MiGallery's viewer follows) - and fades with the tap that hides it.
      -->
      <div
        class="flex shrink-0 items-center justify-between gap-3 px-3 pb-2 {immersive
          ? 'absolute inset-x-0 top-0 z-20 bg-black/45 transition-opacity duration-200'
          : 'border-b border-white/8 bg-linear-to-b from-black/30 to-transparent sm:px-4 sm:pb-3'} {immersive &&
        chromeHidden
          ? 'pointer-events-none opacity-0'
          : ''}"
        style="padding-top: max({immersive
          ? '0.5rem'
          : '0.75rem'}, env(safe-area-inset-top, 0.75rem));"
      >
        <div class="flex min-w-0 flex-1 items-center gap-2">
          {#if immersive}
            <button
              type="button"
              class="ui-icon-button rounded-full transition-colors hover:bg-white/15"
              onclick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label={m.common_back()}
              title={m.common_back()}
            >
              <ArrowLeft size={24} strokeWidth={2.25} />
            </button>
          {/if}
          {@render headerLead?.()}
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          {@render headerActions?.()}
          {#if !immersive}
            <button
              type="button"
              class="ui-icon-button rounded-lg bg-white/15 transition-colors hover:bg-white/25"
              onclick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label={m.common_close_label()}
            >
              <X size={22} strokeWidth={2.5} />
            </button>
          {/if}
        </div>
      </div>

      {@render children?.()}

      {#if footer}
        <div
          class="shrink-0 {immersive
            ? 'absolute inset-x-0 bottom-0 z-20 transition-opacity duration-200'
            : ''} {immersive && chromeHidden ? 'pointer-events-none opacity-0' : ''}"
          style="padding-bottom: max(0.5rem, var(--safe-area-inset-bottom, 0.5rem));"
        >
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
</div>
