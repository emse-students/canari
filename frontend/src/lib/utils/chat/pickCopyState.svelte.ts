/**
 * WHAT THE ANDROID APP SAYS WHILE IT COPIES A PICKED FILE (`PickedFiles.kt`, `canari-pick-copy`).
 *
 * The file chooser answers the page only once every pick is copied to the app's own cache, and a
 * large pick is a long read the page cannot otherwise see - the composer showed nothing for it. Two
 * facts reach the page here, as `window` CustomEvents the native side dispatches:
 *
 * - the copy's progress (`start`, `progress` with a whole percent, `end`), drawn as one line by the
 *   composer ({@link pickCopy}.`reading`);
 * - a pick REFUSED for its size (`refused`, `too-large`, by file name): the page receives only an
 *   empty file for it, which cannot tell a size refusal from an unreadable pick, so the refusal is
 *   remembered by name and {@link takePickRefusal} lets the pick's own refusal say "too large".
 *
 * Outside the Android app nothing dispatches the event and this stays idle.
 */

/** The event the native copy dispatches on `window`. */
export const PICK_COPY_EVENT = 'canari-pick-copy';

/** One decoded native event; `null` from {@link parsePickCopyEvent} for anything else. */
export type PickCopyEvent =
  | { phase: 'start'; name: string }
  | { phase: 'progress'; percent: number }
  | { phase: 'end' }
  | { phase: 'refused'; reason: 'too-large'; name: string; limitMb: number };

/**
 * Types a native `detail` payload. Anything not exactly one of the shapes above is `null`, and the
 * caller logs it: a payload this build does not know is a native/page version skew, never ignored.
 */
export function parsePickCopyEvent(detail: unknown): PickCopyEvent | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  switch (d.phase) {
    case 'start':
      return typeof d.name === 'string' ? { phase: 'start', name: d.name } : null;
    case 'progress':
      return typeof d.percent === 'number' ? { phase: 'progress', percent: d.percent } : null;
    case 'end':
      return { phase: 'end' };
    case 'refused':
      return d.reason === 'too-large' && typeof d.name === 'string' && typeof d.limitMb === 'number'
        ? { phase: 'refused', reason: 'too-large', name: d.name, limitMb: d.limitMb }
        : null;
    default:
      return null;
  }
}

class PickCopyState {
  /** A pick is being copied; `percent` is its whole percent, `null` while no total is known. */
  reading = $state<{ percent: number | null } | null>(null);
  #refusals = new Map<string, number>();

  /** Applies one native event. */
  apply(event: PickCopyEvent): void {
    switch (event.phase) {
      case 'start':
        this.reading = { percent: null };
        return;
      case 'progress':
        this.reading = { percent: Math.max(0, Math.min(100, Math.round(event.percent))) };
        return;
      case 'end':
        this.reading = null;
        return;
      case 'refused':
        this.#refusals.set(event.name, event.limitMb);
        return;
    }
  }

  /**
   * The size limit (MB) the native copy refused the pick named `name` for, once; `null` when it
   * refused nothing of that name (the pick was unreadable for another reason).
   */
  takeRefusal(name: string): number | null {
    const limit = this.#refusals.get(name) ?? null;
    this.#refusals.delete(name);
    return limit;
  }

  /** Forgets everything (tests, sign-out). */
  reset(): void {
    this.reading = null;
    this.#refusals.clear();
  }
}

export const pickCopy = new PickCopyState();

let listening = false;

/**
 * Starts listening for the native copy's events, once. Idempotent; called by the composer on mount,
 * which is always mounted before a pick can be made in it.
 */
export function watchNativePickCopy(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(PICK_COPY_EVENT, (e) => {
    const event = parsePickCopyEvent((e as CustomEvent).detail);
    if (event === null) {
      console.warn('[MEDIA] a pick-copy event this build does not know was ignored');
      return;
    }
    pickCopy.apply(event);
  });
}
