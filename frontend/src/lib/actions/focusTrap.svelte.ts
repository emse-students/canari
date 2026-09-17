const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Svelte action that traps keyboard focus within a container element.
 *
 * On mount: focuses the first focusable child and saves the previously
 * focused element. On destroy: returns focus to the saved element so
 * keyboard users land back where they triggered the overlay.
 *
 * **MOVING FOCUS INTO AN OVERLAY MUST NEVER SCROLL THE PAGE THE OVERLAY COVERS**, and until
 * 2026-09-17 it scrolled it to the very top. The user met it on a phone, reporting that tapping an
 * event in the planning list *"renvoie vers le haut de la page"* - but nothing in that page was the
 * cause, and every modal in the app did it. Three facts compose:
 *
 *  1. `.page-scroll-wrap` carries `will-change: transform` for the swipe-between-tabs gesture, which
 *     makes it the containing block for every `position: fixed` descendant (`app.css`). A backdrop
 *     written `fixed inset-0` inside a page is therefore laid out at that SCROLLER's origin - the
 *     top of its content - and not at the viewport.
 *  2. A portalled overlay is created in place and moved to the body one effect later, and the
 *     child's action runs FIRST: Svelte 5 emits `$.action(<panel>, focusTrap)` before
 *     `$.action(<backdrop>, portal)`, measured by compiling that exact shape. So for one effect the
 *     panel really is inside the scroller, near its top.
 *  3. `HTMLElement.focus()` scrolls its ancestors to reveal the element.
 *
 * Together: focusing the panel's first control asks the browser to reveal something sitting at
 * scroll offset zero of a page scrolled anywhere else, so the page jumps to the top and stays there
 * once the portal moves the overlay away. Measured in Chrome on that geometry: scroller at 1500px,
 * 0px after `focus()`, 1500px after `focus({ preventScroll: true })`.
 *
 * The fix is `preventScroll`, not a reordering of the two actions. A focus trap has NO reason to
 * scroll anything when it opens: the container it focuses into is an overlay that already covers the
 * viewport, and its first control is at the top of a panel nobody has scrolled yet. Saying that here
 * holds whatever order the two effects run in, where a reordering would be an implicit dependency on
 * how one version of Svelte emits actions.
 */
export function focusTrap(node: HTMLElement) {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  function getFocusable(): HTMLElement[] {
    return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;

    const focusable = getFocusable();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // THESE TWO KEEP THE BROWSER'S SCROLLING, DELIBERATELY. They wrap Tab around inside a panel a
    // person may well have scrolled, and `preventDefault` above has just cancelled the scroll the
    // browser's own sequential navigation would have done - so suppressing it here would move focus
    // to a control nobody can see. They are also unreachable before the portal has moved the
    // overlay, which is what makes the mount-time calls above different.
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Auto-focus first interactive element; fall back to the container itself.
  // `preventScroll` on BOTH - see the header. Neither has anything to reveal, and both are capable
  // of throwing the page behind the overlay back to the top.
  const focusable = getFocusable();
  if (focusable.length > 0) {
    focusable[0].focus({ preventScroll: true });
  } else {
    node.focus({ preventScroll: true });
  }

  node.addEventListener('keydown', handleKeydown);

  return {
    destroy() {
      node.removeEventListener('keydown', handleKeydown);
      // Restore focus to the element that was active before the overlay opened.
      previouslyFocused?.focus();
    },
  };
}
