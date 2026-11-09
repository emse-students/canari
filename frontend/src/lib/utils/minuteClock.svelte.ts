import { createSubscriber } from 'svelte/reactivity';

/**
 * ONE shared minute tick for every relative-time label on screen. A label that reads
 * `Date.now()` only inside a `$derived` fed by its timestamp never advances ("3 min" stays "3
 * min"), and a timer per row would be hundreds of intervals in a long list. The subscriber is
 * shared: the single interval runs while at least one reactive reader exists and stops with the
 * last one. A page woken from sleep (timers frozen) redraws when it becomes visible again.
 */
const subscribe = createSubscriber((update) => {
  const id = setInterval(update, 60_000);
  const onVisible = () => {
    if (document.visibilityState === 'visible') update();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVisible);
  };
});

/** `Date.now()`, registered as a dependency that is invalidated every minute. Call inside `$derived`/`$effect`. */
export function minuteNow(): number {
  subscribe();
  return Date.now();
}
