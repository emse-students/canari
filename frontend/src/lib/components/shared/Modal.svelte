<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import type { Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { swipeBack } from '$lib/actions/swipeBack';
  import { insideViewerLayer } from '$lib/utils/viewerLayer';
  import {
    pushHistoryOverlay,
    closeHistoryOverlayFromUi,
    releaseHistoryOverlay,
    armHistoryOverlayGesture,
    backHistoryOverlayFromGesture,
    isMobileOverlayLayout,
    type HistoryGestureArm,
  } from '$lib/utils/historyOverlayStack';

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
    /**
     * Anchor the panel to the TOP of a phone screen instead of the bottom.
     *
     * THE DEFAULT BOTTOM SHEET RIDES THE KEYBOARD, and for a modal whose first control is a text
     * field that is the whole experience: the sheet is pinned to the bottom edge, so opening the
     * keyboard shoves the entire panel up the screen and closing it drops the panel back down
     * (user, 2026-09-08, about creating a conversation: *"le fait que ce soit colle en bas n'est
     * pas pratique (deplacement lors de l'ouverture et la fermeture du clavier par exemple)"*).
     *
     * A sheet is still right for a short modal with no input - a confirmation, a menu - which is
     * why this is a flag and not a change of default. `fullViewport` is NOT the same lever: it
     * also blows the panel up to `90rem` on desktop, which a contact picker must not be.
     */
    topAnchored?: boolean;
    /**
     * On a phone, the panel covers the WHOLE screen, edge to edge, and the body is handed over
     * unpadded and unscrolled - on a larger screen it stays a centred dialog.
     *
     * This is the lever a composer needs and `fullViewport` is not. The overlay already follows the
     * visual viewport (`[data-keyboard-aware-overlay]` in `app.css` sets its height to the space
     * above the keyboard), so a panel that FILLS the overlay has its bottom edge on the keyboard: a
     * child laid out as a scroll region plus a footer gets that footer pinned above the keyboard
     * with nothing computed here. Two things stood in the way and this flag removes both: the
     * overlay's 1rem moat on every side, and the `92dvh` cap `.keyboard-aware-modal-panel` puts on
     * every panel. The safe areas the moat also covered are kept (`.modal-phone-full`, `app.css`).
     *
     * Asked by the user on 2026-09-29, comparing the post composer with Facebook's on the Mi 9T: a
     * full-screen page, the text area taking the height, the actions under the thumb.
     */
    phoneFullScreen?: boolean;
    /**
     * Draw the title bar. False keeps `title` as the dialog's accessible name only, for a modal
     * that draws its own heading (the PIN gate is a lock screen, not a form under a bar).
     */
    showTitleBar?: boolean;
    /**
     * Draw the footer as an EDGE: a border and 12 px of its own room, so a body that scrolls ends
     * at a line above the footer's button and never against it. For a modal whose body is a form
     * that overflows once the keyboard is up - the PIN change's confirm field read as covered BY
     * its submit button (iPhone 12, v1.2.9-alpha.4). Opt-in: a one-line confirmation does not
     * overflow and gets no line; the title bar's `border-b` is the same edge at the top.
     */
    footerEdge?: boolean;
    /**
     * `critical` for a dialog raised OVER a full-screen viewer (`--z-viewer` sits above `--z-modal`,
     * so a plain modal would open hidden behind the live it is about).
     */
    layer?: 'modal' | 'critical';
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
    topAnchored = false,
    phoneFullScreen = false,
    showTitleBar = true,
    footerEdge = false,
    layer = 'modal',
    onClose,
    children,
    footer,
  }: Props = $props();

  /** Opened from inside a full-screen viewer, the modal rung is under it (`utils/viewerLayer.ts`). */
  const inViewer = insideViewerLayer();

  const backdropAlignClass = $derived(
    fullViewport || topAnchored || phoneFullScreen
      ? 'items-stretch sm:items-center'
      : 'items-end sm:items-center'
  );

  /*
   * ONE OF THESE FOUR IS EMITTED, NEVER TWO. They set the same properties, so a panel carrying two
   * of them would be decided by Tailwind's class ORDER rather than by the flags - which is the trap
   * the `fullViewport` comment already warns about, and `topAnchored` would have walked into it.
   *
   * `topAnchored` SETS NEITHER A HEIGHT NOR A RADIUS OVERRIDE, and both omissions are measured.
   * It shipped as `h-[100dvh] max-h-[100dvh] rounded-none`, all three of which were wrong on the
   * phone this was written for (Mi 9T, 2026-09-09):
   *
   *  - the max-height never applied. `.keyboard-aware-modal-panel` in `app.css` caps every panel at
   *    `min(92dvh, var(--app-viewport-height)) !important`, so THAT rule owns the cap and no
   *    utility here can move it - measured 540.85px against a `100dvh` of 587.88px.
   *  - the height was redundant and 3px harmful. The backdrop is `items-stretch` on a phone, so a
   *    panel with no height already fills the padded box (537.88px); `100dvh` only pushed it past
   *    the backdrop's own bottom padding until the cap above clamped it.
   *  - `rounded-none` is for a panel that reaches the screen edges, and this one never does: the
   *    backdrop pads `max(1rem, env(safe-area-inset-*))` on all four sides, so square corners drew
   *    a slab floating in a 16px moat. Rounded is also what the user asked every panel to be
   *    (2026-09-08, about the conversation panels: *"comme les autres blocs, avec les coins
   *    arrondis etc"*).
   */
  const panelSizeClass = $derived(
    fullViewport
      ? 'h-[100dvh] max-h-[100dvh] rounded-none sm:h-[min(96dvh,100%)] sm:max-h-[96dvh] sm:rounded-2xl sm:w-[min(96vw,90rem)]'
      : phoneFullScreen
        ? 'rounded-none max-sm:border-0 sm:h-[min(88dvh,48rem)] sm:rounded-2xl'
        : topAnchored
          ? 'rounded-2xl'
          : 'max-h-[92dvh] rounded-t-3xl sm:rounded-2xl'
  );

  let historyClose: (() => void) | null = null;

  /**
   * THE LEFT-EDGE SWIPE IS THIS LAYER'S BACK TOO. The iOS app has no system Back: its only one is
   * the swipe the conversation draws (`swipeBack`), and a modal is portalled to `document.body`,
   * OUT of the conversation, so a swipe over its backdrop reached nothing (iPhone 12, 2026-10-16;
   * the camera layer met the same wall). It closes the TOP overlay through the same stack the
   * Android back button uses.
   *
   * ENABLED ONLY WHEN `dismissible`: a gate registers NO entry, so the top overlay would be the one
   * UNDER it and the swipe would close a layer the person is not looking at. `narrow` is the
   * predicate the stack's entries share, read once: the layer lives for one open.
   */
  const narrow = isMobileOverlayLayout();
  let gestureArm: HistoryGestureArm | null = null;

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
      // Closed by its owner's state (a publish, a save): the entry must leave the stack too, or
      // the tab swipe stays stood down until some navigation drains it.
      releaseHistoryOverlay(historyClose);
      historyClose = null;
    }
  });

  /**
   * DESTROYED WITH `open` STILL TRUE. A sheet drawn as `{#if sheet}<Modal open .../>` is handed
   * over by clearing `sheet`: `open` never turns false, so the effect above never releases the
   * entry, and one Android Back later closed a layer nobody was looking at ("did nothing"). A
   * teardown-only effect (no dependency) releases it when the component goes.
   */
  $effect(() => () => {
    if (historyClose) {
      releaseHistoryOverlay(historyClose);
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
      use:coversScreen
      data-keyboard-aware-overlay
      class="fixed {layer === 'critical'
        ? 'z-(--z-critical)'
        : inViewer
          ? 'z-(--z-viewer-dialog)'
          : 'z-(--z-modal)'} flex justify-center bg-black/40 {backdropAlignClass} {phoneFullScreen
        ? 'modal-phone-full'
        : ''}"
      onclick={handleBackdropClick}
      use:swipeBack={{
        onBack: () => {
          const arm = gestureArm;
          gestureArm = null;
          void backHistoryOverlayFromGesture(arm);
        },
        onArm: () => (gestureArm = armHistoryOverlayGesture()),
        enabled: narrow && dismissible,
      }}
      in:fly={{ duration: 200, y: 0, opacity: 0 }}
    >
      <!-- `overflow-hidden`: the panel owns its corners, so a child that paints its own background
           at an edge (the composer's action bar) is clipped to them instead of squaring them. -->
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabindex="-1"
        use:focusTrap
        class="keyboard-aware-modal-panel border-cn-border w-full overflow-hidden border bg-(--cn-surface) shadow-2xl {maxWidth} text-text-main flex flex-col sm:mx-4 {panelSizeClass} {panelClass}"
        in:fly={{ duration: 220, y: 24 }}
        onclick={(e) => e.stopPropagation()}
        onkeydown={handlePanelKeydown}
      >
        {#if title && showTitleBar}
          <div
            class="border-cn-border flex shrink-0 items-center justify-between border-b px-6 py-4"
          >
            <h2 class="text-cn-dark text-base font-semibold">{title}</h2>
            {#if dismissible}
              <button
                onclick={dismiss}
                class="ui-icon-button hover:bg-cn-bg text-text-muted hover:text-cn-dark rounded-lg transition-colors"
                aria-label={m.common_close_label()}
              >
                <X size={16} />
              </button>
            {/if}
          </div>
        {/if}

        <div
          class="flex-1 overscroll-contain {phoneFullScreen
            ? 'flex min-h-0 flex-col'
            : `px-6 py-4 ${bodyClass || 'overflow-y-auto'}`}"
        >
          {@render children?.()}
        </div>

        {#if footer}
          <div
            class="flex shrink-0 justify-end gap-2 px-6 pb-4 {footerEdge
              ? 'border-cn-border border-t pt-3'
              : ''}"
            data-modal-footer
            data-modal-footer-edge={footerEdge ? '' : undefined}
          >
            {@render footer?.()}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
