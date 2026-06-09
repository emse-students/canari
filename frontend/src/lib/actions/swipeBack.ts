/**
 * Svelte action that adds an edge-swipe-to-go-back gesture (iOS-style).
 * Activates only when the touch starts within `edgeZonePx` from the left edge.
 */

export interface SwipeBackOptions {
  /** Called when the gesture is confirmed (swipe right past threshold). */
  onBack: () => void;
  /** Whether the gesture is currently active (e.g. only on mobile view). */
  enabled?: boolean;
  /** Width of the left-edge activation zone in px (default 28). */
  edgeZonePx?: number;
  /** Minimum horizontal travel in px to trigger back (default 90). */
  threshold?: number;
}

export function swipeBack(node: HTMLElement, options: SwipeBackOptions) {
  let opts = options;

  let startX = 0;
  let startY = 0;
  let tracking = false;
  let committed = false;

  function onTouchStart(e: TouchEvent) {
    if (!opts.enabled) return;
    const t = e.touches[0];
    const edgeZone = opts.edgeZonePx ?? 28;
    if (t.clientX > edgeZone) return;
    startX = t.clientX;
    startY = t.clientY;
    tracking = true;
    committed = false;
  }

  function onTouchMove(e: TouchEvent) {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);

    // Abort if the gesture is more vertical than horizontal.
    if (dy > dx * 1.2 && dx < 20) {
      tracking = false;
      node.style.removeProperty('transform');
      return;
    }

    if (dx < 0) {
      tracking = false;
      node.style.removeProperty('transform');
      return;
    }

    const threshold = opts.threshold ?? 90;
    // Elastic resistance: give tactile feedback by translating the view.
    const drag = Math.min(dx * 0.55, threshold * 0.8);
    node.style.transform = `translate3d(${drag}px, 0, 0)`;

    if (dx >= threshold && !committed) {
      committed = true;
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const threshold = opts.threshold ?? 90;

    if (dx >= threshold) {
      // Slide out to the right then invoke callback.
      node.style.transition = 'transform 0.18s ease-out';
      node.style.transform = `translate3d(${node.offsetWidth * 0.35}px, 0, 0)`;
      node.addEventListener(
        'transitionend',
        () => {
          node.style.removeProperty('transform');
          node.style.removeProperty('transition');
          opts.onBack();
        },
        { once: true }
      );
    } else {
      // Snap back.
      node.style.transition = 'transform 0.2s ease-out';
      node.style.transform = 'translate3d(0, 0, 0)';
      node.addEventListener(
        'transitionend',
        () => {
          node.style.removeProperty('transform');
          node.style.removeProperty('transition');
        },
        { once: true }
      );
    }
  }

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: true });
  node.addEventListener('touchend', onTouchEnd);

  return {
    update(newOptions: SwipeBackOptions) {
      opts = newOptions;
    },
    destroy() {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
    },
  };
}
