/**
 * THE MOUSE WHEEL TURNS THE CANAREELS ON A DESKTOP, ONE GESTURE ONE PAGE (user, 2026-10-19): a
 * notch down is the next reel, up the previous - the arrow buttons' and keys' own step
 * (`ReelViewer.go`), never a second paging path.
 *
 * ONE GESTURE IS MANY EVENTS: a trackpad flick or a free-spinning wheel sends dozens, and its
 * inertia keeps sending after the page has landed. So a new page is turned only when BOTH the last
 * page has landed (the viewer's own `settling`, the one state every entry point reads) AND the
 * wheel has gone quiet for {@link WHEEL_QUIET_MS} - every event in between is swallowed and
 * restarts the quiet. The quiet is the only way to know a gesture ended: the wheel sends no "end".
 */

/** How long the wheel must stay silent before a new event is a new gesture. */
export const WHEEL_QUIET_MS = 200;

/** What a wheel event asks of the reel pager. */
export type WheelStep = 'next' | 'prev' | null;

/**
 * The page a wheel event asks for: the sign of `deltaY`, down is the next reel. A pinch-zoom
 * (`ctrlKey`, which browsers also send for a trackpad pinch), a mostly horizontal scroll and a zero
 * delta ask for nothing, and are left to the browser.
 */
export function wheelStep(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey'>): WheelStep {
  if (e.ctrlKey || e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return null;
  return e.deltaY > 0 ? 'next' : 'prev';
}

/**
 * Whether the wheel over `target` belongs to a child that scrolls on that axis (the comments list,
 * an unfolded caption) - checked up to `root`, the viewer. Such a child scrolls; the reel stays.
 */
export function wheelOverScrollable(target: EventTarget | null, root: Element): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== root) {
    if (el.matches('[data-comments-drawer], [data-reel-caption-open]')) return true;
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** The wheel's half of the one-gesture-one-page rule: has it been quiet (see the module comment). */
export class WheelPageLock {
  private quiet = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Whether a new gesture may turn the page now. */
  get free(): boolean {
    return this.quiet;
  }

  /** Every wheel event on the viewer: it restarts the quiet. */
  heard(): void {
    this.quiet = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.quiet = true;
    }, WHEEL_QUIET_MS);
  }

  /** The viewer goes away. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
