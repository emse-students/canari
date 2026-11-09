/**
 * Whether a finger is on an element, and a promise for the moment none is - read from the touches
 * themselves, never from a timer.
 *
 * The entry widen of a conversation writes `scrollTop` after each step, to keep the rows the reader
 * sees in place while older ones are added above. A write while a finger drags the pane fights the
 * drag, and on iOS WebKit it can cancel the scroll the drag started. So a step waits for the hand to
 * lift: `touchend` / `touchcancel` with no touch left on the element.
 */
export interface TouchHold {
  /** True while at least one touch that started on the element is still down. */
  readonly held: boolean;
  /** Resolves at once when nothing is held, else at the release of the last touch (or `dispose`). */
  whenReleased(): Promise<void>;
  /** Removes the listeners and releases every waiter. */
  dispose(): void;
}

/**
 * Starts watching `el`'s touches.
 *
 * @param el The scroller whose drags a write must not interrupt.
 */
export function trackTouchHold(el: HTMLElement): TouchHold {
  let held = false;
  let waiters: (() => void)[] = [];
  const release = () => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  };
  const onStart = () => {
    held = true;
  };
  const onEnd = (e: TouchEvent) => {
    // `touches` is every finger still on the screen; the hold is over when none is left.
    if (e.touches.length > 0) return;
    held = false;
    release();
  };
  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchend', onEnd, { passive: true });
  el.addEventListener('touchcancel', onEnd, { passive: true });
  return {
    get held() {
      return held;
    },
    whenReleased() {
      return held ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve();
    },
    dispose() {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      held = false;
      release();
    },
  };
}
