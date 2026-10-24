<script lang="ts">
  /**
   * THE COMMENTS DRAWER - ONE BOTTOM SHEET FOR EVERY THREAD ON A PHONE (user, 2026-10-23: the
   * comments of a post open in the same drawer as a CanaReel's, over the interface). It is the
   * mechanics `ReelCommentsSheet` used to carry, moved here so a post's thread and a reel's are ONE
   * component and not two copies: about 60 % of the screen, large top corners, a grabber and a
   * title, the body in the height left (the thread is the caller's, as `children`).
   *
   * It rises on `motion-sheet-in` and CLOSES as Instagram's does: a drag down on its top (the
   * grabber and the title - the list under it scrolls), the system Back (a history entry,
   * `bindHistoryOverlay`, so Back closes the drawer before whatever lies under it), a tap on what
   * is above it, Escape, and the X. Dragging, the X, Escape and the backdrop slide it out on the
   * same snap (`settle`); with reduced motion everything is at once.
   *
   * TWO PLACES, ONE SHAPE. Inline (`scrim` false, the reel viewer): it fills the positioned parent
   * and the part above stays visible and live, the reel playing. Over the page (`scrim` true, a
   * post's thread): it is portalled to the body and dims the interface, `aria-modal`, the focus
   * held inside (`focusTrap`) and given back to the opener on close.
   *
   * THE KEYBOARD: the drawer rides it (`keyboard-aware-bottom`) and is never taller than what the
   * keyboard leaves (`--app-viewport-height`), so the composer stays above the keys.
   */
  import { onMount, tick, type Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { GESTURE, decideDismiss, releaseVelocity, type Sample } from '$lib/utils/viewerGestures';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The drawer is closed: the history entry is gone and the owner unmounts it. */
    onClose: () => void;
    /** The drawer starts sliding out (X, Escape, a tap above, a drag release), before `onClose`. */
    onClosing?: () => void;
    /** Over the page: dims it, portals to the body, holds the focus. Inline when false. */
    scrim?: boolean;
    /** Escape stands aside while a dialog of the owner's is open above the drawer. */
    escapeBlocked?: boolean;
    /** For the debug lines. */
    label?: string;
    children: Snippet;
  }

  let {
    onClose,
    onClosing,
    scrim = false,
    escapeBlocked = false,
    label = 'comments',
    children,
  }: Props = $props();

  let sheet = $state<HTMLDivElement | null>(null);
  /** How far the sheet is dragged down, px. */
  let dragY = $state(0);
  let settling = $state(false);
  let closing = $state(false);
  let afterSettle: (() => void) | null = null;
  /** Whatever had the focus when the drawer opened - the comment button - to hand it back. */
  // Read at initialisation: `focusTrap` moves the focus into the sheet before `onMount` runs.
  const opener: HTMLElement | null =
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const overlay = bindHistoryOverlay(
    () => true,
    () => {
      console.debug(`[comments-drawer] ${label} closed`);
      onClose();
    }
  );

  onMount(() => {
    overlay.syncOpen();
    console.debug(`[comments-drawer] ${label} opened`);
    // Takes the focus unless the body already did (a composer asked for the caret).
    void tick().then(() => {
      if (!sheet?.contains(document.activeElement)) sheet?.focus({ preventScroll: true });
    });
    return () => opener?.focus({ preventScroll: true });
  });

  /** Over the page only: the wrapper leaves the page's containing block and covers the screen. */
  function overPage(node: HTMLElement, on: boolean) {
    if (!on) return {};
    const moved = portal(node);
    const covers = coversScreen(node);
    return {
      destroy() {
        covers.destroy?.();
        moved?.destroy?.();
      },
    };
  }

  /** The focus held inside the sheet over the page; inline it is the reel's, as it always was. */
  function holdFocus(node: HTMLElement, on: boolean) {
    return on ? focusTrap(node) : {};
  }

  function reducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** Every way out but Back: the history entry goes with it, so Back is not owed twice. */
  function close() {
    overlay.dismissFromUi();
  }

  /** The X, a tap above and Escape: slides out on the snap of a drag release, then closes. */
  function closeAnimated() {
    if (closing) return;
    closing = true;
    onClosing?.();
    settle(sheet?.clientHeight ?? window.innerHeight, close);
  }

  /** Moves the sheet to `y` with the snap transition, then `then` - at once with reduced motion. */
  function settle(y: number, then?: () => void) {
    if (reducedMotion() || y === dragY) {
      dragY = y;
      settling = false;
      then?.();
      return;
    }
    settling = true;
    afterSettle = then ?? null;
    dragY = y;
  }

  function onTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    settling = false;
    const next = afterSettle;
    afterSettle = null;
    next?.();
  }

  // THE DRAG DOWN, on the sheet's top only: the list under it scrolls (a swipe over the comments
  // scrolled them on the Mi 9T, and did not close it).
  let dragStart: Sample | null = null;
  let samples: Sample[] = [];

  function onHandleDown(e: PointerEvent) {
    if (settling || (e.target as HTMLElement).closest('button')) return;
    dragStart = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    samples = [dragStart];
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onHandleMove(e: PointerEvent) {
    if (!dragStart) return;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (samples.length > 12) samples.shift();
    dragY = Math.max(0, e.clientY - dragStart.y);
  }

  function onHandleUp(e: PointerEvent) {
    if (!dragStart) return;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    const dy = e.clientY - dragStart.y;
    dragStart = null;
    const height = sheet?.clientHeight ?? window.innerHeight;
    const closes = decideDismiss({ dy, velocityY: releaseVelocity(samples).y, height });
    console.debug(
      `[comments-drawer] ${label} drag released at ${Math.round(dy)} px: ${closes ? 'close' : 'stay'}`
    );
    if (closes) {
      closing = true;
      onClosing?.();
      settle(height, close);
    } else settle(0);
  }

  function onHandleCancel() {
    dragStart = null;
    settle(0);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || escapeBlocked) return;
    e.preventDefault();
    closeAnimated();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  use:overPage={scrim}
  class="{scrim ? 'fixed z-(--z-modal)' : 'absolute'} inset-0 flex flex-col"
  data-comments-drawer
>
  <!-- WHAT IS ABOVE THE SHEET: a tap on it closes the drawer (Instagram's). A button, so a viewer's
       swipe stands aside on it; hidden from assistive tech, which has the X. -->
  <button
    type="button"
    class="min-h-0 flex-1 cursor-default {scrim ? 'motion-fade-in bg-black/40' : ''}"
    tabindex="-1"
    aria-hidden="true"
    onclick={closeAnimated}
    data-comments-drawer-backdrop
  ></button>

  <div
    bind:this={sheet}
    use:holdFocus={scrim}
    class="motion-sheet-in keyboard-aware-bottom bg-cn-surface text-text-main absolute inset-x-0 bottom-0 flex h-[60dvh] max-h-[calc(var(--app-viewport-height,100dvh)-var(--safe-area-inset-top,0px)-3rem)] flex-col rounded-t-3xl pb-[var(--safe-area-inset-bottom,0px)] shadow-2xl outline-none"
    style:transform="translate3d(0, {dragY}px, 0)"
    style:transition={settling
      ? `transform ${GESTURE.SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
      : 'none'}
    ontransitionend={onTransitionEnd}
    role="dialog"
    aria-modal={scrim}
    aria-labelledby="comments-drawer-title"
    tabindex="-1"
    data-comments-drawer-sheet
  >
    <div
      class="flex shrink-0 cursor-grab touch-none flex-col items-center px-2 pt-2 select-none"
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={onHandleUp}
      onpointercancel={onHandleCancel}
      role="presentation"
      data-comments-drawer-handle
    >
      <span class="h-1 w-10 rounded-full bg-current opacity-25" aria-hidden="true"></span>
      <div class="grid w-full grid-cols-[2.75rem_1fr_2.75rem] items-center">
        <span></span>
        <h2 id="comments-drawer-title" class="text-center text-sm font-bold">
          {m.reels_comments_title()}
        </h2>
        <button
          type="button"
          class="ui-icon-button rounded-full outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-white/10"
          aria-label={m.reels_comments_close()}
          title={m.reels_comments_close()}
          onclick={closeAnimated}
          data-comments-drawer-close
        >
          <X size={20} strokeWidth={2.5} />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      {@render children()}
    </div>
  </div>
</div>
