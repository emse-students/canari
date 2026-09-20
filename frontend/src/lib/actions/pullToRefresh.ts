/**
 * Svelte action that adds a native-feeling pull-to-refresh gesture to any scrollable element.
 *
 * It needs a non-passive `touchmove` to claim the pull, and a non-passive `touchmove` takes its
 * scroller off the compositor for as long as it is bound - so it is bound only where the gesture
 * can begin. See `syncMoveBinding` at the foot of this file.
 */

export interface PullToRefreshOptions {
  /** Called when the user pulls past the threshold. Must return a Promise. */
  onRefresh: () => Promise<void>;
  /** Vertical distance in px the user must pull before triggering refresh (default 72). */
  threshold?: number;
  /**
   * Asked once per gesture: has `onRefresh` anything to do right now? Defaults to always.
   *
   * A SPINNER IS A PROMISE THAT SOMETHING IS HAPPENING, and a caller with nothing to do had no way
   * to decline the gesture - it could only resolve immediately, which still painted the indicator.
   * Returning `false` here leaves the pull to the scroller, so the spinner appears if and only if
   * work follows it.
   */
  enabled?: () => boolean;
}

// Inject the spinner keyframe once per document.
function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('ptr-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'ptr-keyframes';
  style.textContent = '@keyframes ptr-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

export function pullToRefresh(node: HTMLElement, options: PullToRefreshOptions) {
  const { onRefresh, threshold = 72, enabled } = options;

  ensureStyles();

  let startY = 0;
  let active = false;
  let refreshing = false;
  let indicator: HTMLDivElement | null = null;

  function getOrCreateIndicator(): HTMLDivElement {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    Object.assign(indicator.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      height: '0',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '50',
      pointerEvents: 'none',
    });
    const spinner = document.createElement('div');
    Object.assign(spinner.style, {
      width: '20px',
      height: '20px',
      border: '2px solid #f59e0b',
      borderTopColor: 'transparent',
      borderRadius: '50%',
      animation: 'ptr-spin 0.6s linear infinite',
      flexShrink: '0',
    });
    indicator.appendChild(spinner);
    // Only promote to `relative` when the node has no positioning of its own.
    // Overriding `position: absolute` would collapse the element's height and break scroll.
    if (getComputedStyle(node).position === 'static') {
      node.style.position = 'relative';
    }
    node.prepend(indicator);
    return indicator;
  }

  function removeIndicator() {
    indicator?.remove();
    indicator = null;
  }

  function onTouchStart(e: TouchEvent) {
    if (node.scrollTop > 0 || refreshing) return;
    // ASKED PER GESTURE, not once at mount: whether a refresh has work is a property of the moment
    // (the socket is up, or it is not), and an action bound at mount would answer for ever.
    if (enabled && !enabled()) return;
    startY = e.touches[0].clientY;
    active = true;
  }

  function onTouchMove(e: TouchEvent) {
    if (!active || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      active = false;
      removeIndicator();
      return;
    }
    // Prevent the browser from scrolling the element while we handle the gesture.
    e.preventDefault();
    const el = getOrCreateIndicator();
    // Apply elastic resistance: drag further → smaller increments.
    const height = Math.min(dy * 0.45, threshold * 0.8);
    el.style.height = `${height}px`;
    el.style.opacity = String(Math.min(dy / threshold, 1));
  }

  function onTouchEnd(e: TouchEvent) {
    if (!active) return;
    active = false;
    const dy = e.changedTouches[0].clientY - startY;

    if (dy >= threshold && !refreshing) {
      refreshing = true;
      const el = getOrCreateIndicator();
      el.style.transition = 'none';
      el.style.height = '44px';
      el.style.opacity = '1';

      Promise.resolve(onRefresh()).finally(() => {
        refreshing = false;
        if (indicator) {
          indicator.style.transition = 'height 0.25s ease, opacity 0.25s ease';
          indicator.style.height = '0';
          indicator.style.opacity = '0';
          setTimeout(() => removeIndicator(), 280);
        }
      });
    } else {
      if (indicator) {
        indicator.style.transition = 'height 0.2s ease, opacity 0.2s ease';
        indicator.style.height = '0';
        indicator.style.opacity = '0';
        setTimeout(() => removeIndicator(), 220);
      }
    }
    startY = 0;
  }

  let moveBound = false;

  function bindMove(): void {
    if (moveBound) return;
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    moveBound = true;
  }

  function unbindMove(): void {
    if (!moveBound) return;
    node.removeEventListener('touchmove', onTouchMove);
    moveBound = false;
  }

  /**
   * THE NON-PASSIVE `touchmove` EXISTS ONLY WHERE THE GESTURE CAN BEGIN, WHICH IS `scrollTop === 0`.
   *
   * `onTouchStart` already refuses anywhere else, so the listener spent the whole of a long feed
   * bound and declining - and a bound non-passive `touchmove` costs its scroller whether or not the
   * handler does anything: the engine cannot know in advance that it will decline, so it marks the
   * region non-fast-scrollable and routes every move through the main thread before it is allowed
   * to scroll. `/posts` binds this action to `.page-scroll-wrap` ITSELF, the app's main scroller, so
   * that was the whole feed, on top of the shell's own listener - both reported from an iPhone on
   * 2026-09-20 as unpainted bands during a scroll.
   *
   * A passive `scroll` listener is what re-asks the question. `active` and `refreshing` hold the
   * binding through a pull that is already under way: the pull is claimed with `preventDefault`, so
   * no scroll event arrives to re-arm it, and a refresh that scrolls the list under itself must not
   * unbind the gesture it is serving.
   */
  function syncMoveBinding(): void {
    if (node.scrollTop === 0 || active || refreshing) bindMove();
    else unbindMove();
  }

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchend', onTouchEnd, { passive: true });
  node.addEventListener('scroll', syncMoveBinding, { passive: true });
  syncMoveBinding();

  return {
    destroy() {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('scroll', syncMoveBinding);
      unbindMove();
      removeIndicator();
    },
  };
}
