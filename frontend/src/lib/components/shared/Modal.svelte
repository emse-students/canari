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
    /**
     * When false, EVERY way of dismissing the modal is disabled - backdrop click, Escape, the
     * header close button, AND the platform back gesture. The last one is the reason this is
     * spelt out: the back button does not come through any of the other three, it comes through
     * the history entry pushed below, and a gate a back press can close is not a gate.
     */
    dismissible?: boolean;
    /** Extra classes appended to the dialog panel (e.g. custom height for near-fullscreen modals). */
    panelClass?: string;
    /** Extra classes appended to the scrollable body div; overrides the default `overflow-y-auto` sizing when set. */
    bodyClass?: string;
    /**
     * When true, the panel fills almost the entire viewport (fullscreen on mobile,
     * near-fullscreen on desktop) instead of the default capped `max-h-[92dvh]` sizing.
     * Sizing utilities are chosen exclusively based on this flag (never both emitted at
     * once) so `panelClass` doesn't fight the default sizing on Tailwind class order.
     */
    fullViewport?: boolean;
    onClose: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let {
    open = false,
    title,
    maxWidth = 'max-w-md',
    dismissible = true,
    panelClass = '',
    bodyClass = '',
    fullViewport = false,
    onClose,
    children,
    footer,
  }: Props = $props();

  const backdropAlignClass = $derived(
    fullViewport ? 'items-stretch sm:items-center' : 'items-end sm:items-center'
  );

  const panelSizeClass = $derived(
    fullViewport
      ? 'h-[100dvh] max-h-[100dvh] rounded-none sm:h-[min(96dvh,100%)] sm:max-h-[96dvh] sm:rounded-2xl sm:w-[min(96vw,90rem)]'
      : 'max-h-[92dvh] rounded-t-3xl sm:rounded-2xl'
  );

  let historyClose: (() => void) | null = null;

  /**
   * THE BACK GESTURE IS A DISMISSAL, AND IT IS THE ONE `dismissible` USED TO MISS.
   *
   * `pushHistoryOverlay` exists so the Android back button closes the overlay a person is looking
   * at rather than navigating the whole app away from underneath it - the entry it pushes is popped
   * by `onPopState`, which calls this `close` callback. It ran for EVERY open modal, including the
   * three that pass `dismissible={false}`, so a back press on a blocking gate called its `onClose`
   * while the backdrop, Escape and the header button were all refusing to.
   *
   * The three gates get away with it today only because each happens to pass `onClose={() => {}}`,
   * which is a property of their call sites and not of this component. The cost was still paid: a
   * gate that pushes an entry nothing will ever pop eats one back press silently, and the person
   * pressing it sees nothing happen.
   *
   * The registration is therefore gated on `dismissible`, which now governs all four paths. A modal
   * whose `dismissible` FLIPS while open (`dismissible={!loading}` on three dialogs) keeps whatever
   * it registered when it opened: the flag is about the person's gesture during a two-second
   * operation, not about the history stack, and abandoning an entry mid-flight would put the two
   * out of step.
   */
  $effect(() => {
    if (open && dismissible && !historyClose) {
      historyClose = () => onClose();
      pushHistoryOverlay(historyClose);
    } else if (!open && historyClose) {
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

  /**
   * Escape, handled WHERE THE KEY ACTUALLY LANDS - inside the panel.
   *
   * The panel stops `keydown` from bubbling (see the handler on the dialog element), and that stop
   * is what made the `svelte:window` listener below dead code for every consumer of this component:
   * `focusTrap` focuses the first control inside the panel on mount, so every keystroke a person
   * makes with a modal open ORIGINATES inside it and is stopped one node above the panel. Measured
   * 2026-09-05 on the community-settings modal: the keydown reached `window` in the CAPTURE phase
   * and never came back in the bubble phase, and the dialog stayed open.
   *
   * The window listener is kept rather than replaced: a keystroke made while focus sits on the
   * BACKDROP - the panel not yet mounted, or focus deliberately moved out - bubbles normally and has
   * no panel to pass through. The two cover disjoint origins, and `dismiss()` is idempotent through
   * `closeHistoryOverlayFromUi` in any case.
   */
  function handlePanelKeydown(e: KeyboardEvent) {
    // STOPPED FIRST, AND STILL STOPPED. Two modals are portaled as SIBLINGS of `body`, not nested,
    // so both window listeners are live at once; without this, one Escape would dismiss the stack
    // rather than the modal the person is looking at.
    e.stopPropagation();
    handleKeydown(e);
  }
</script>

<svelte:window onkeydown={open && dismissible ? handleKeydown : undefined} />

{#if open}
  <div use:portal>
    <div
      role="presentation"
      data-keyboard-aware-overlay
      class="fixed z-[280] flex justify-center bg-black/40 backdrop-blur-sm {backdropAlignClass}"
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
        class="keyboard-aware-modal-panel border-cn-border w-full border bg-(--cn-surface) shadow-2xl {maxWidth} text-text-main flex flex-col sm:mx-4 {panelSizeClass} {panelClass}"
        in:fly={{ duration: 220, y: 24 }}
        onclick={(e) => e.stopPropagation()}
        onkeydown={handlePanelKeydown}
      >
        {#if title}
          <div
            class="border-cn-border flex shrink-0 items-center justify-between border-b px-6 py-4"
          >
            <h2 class="text-cn-dark text-base font-semibold">{title}</h2>
            {#if dismissible}
              <button
                onclick={dismiss}
                class="hover:bg-cn-bg text-text-muted hover:text-cn-dark rounded-lg p-1.5 transition-colors"
                aria-label="Fermer"
              >
                <X size={16} />
              </button>
            {/if}
          </div>
        {/if}

        <div class="flex-1 overscroll-contain px-6 py-4 {bodyClass || 'overflow-y-auto'}">
          {@render children?.()}
        </div>

        {#if footer}
          <div class="flex shrink-0 justify-end gap-2 px-6 pb-4">
            {@render footer?.()}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
