/**
 * Creates an interval that automatically pauses when the page is hidden
 * (app backgrounded on Android/iOS) and resumes when visible again.
 *
 * Calls `fn` once immediately if the page is currently visible, then every `ms`
 * milliseconds. Safe to call during SSR (no-op if `document` is unavailable).
 *
 * @returns Cleanup function - call on component unmount or to stop the interval permanently.
 */
export function createPausableInterval(fn: () => void, ms: number): () => void {
  if (typeof document === 'undefined') return () => {};

  let timer: ReturnType<typeof setInterval> | null = null;

  function start() {
    if (timer !== null) return;
    fn();
    timer = setInterval(fn, ms);
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      stop();
    } else {
      start();
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  if (document.visibilityState === 'visible') {
    start();
  }

  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
