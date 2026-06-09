/**
 * Svelte action that adds a native-feeling pull-to-refresh gesture to any scrollable element.
 * Attaches non-passive touchmove so it can preventDefault when pulling down.
 */

export interface PullToRefreshOptions {
  /** Called when the user pulls past the threshold. Must return a Promise. */
  onRefresh: () => Promise<void>;
  /** Vertical distance in px the user must pull before triggering refresh (default 72). */
  threshold?: number;
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
  const { onRefresh, threshold = 72 } = options;

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

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: false });
  node.addEventListener('touchend', onTouchEnd);

  return {
    destroy() {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      removeIndicator();
    },
  };
}
