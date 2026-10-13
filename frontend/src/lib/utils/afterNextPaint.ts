/**
 * Runs `work` once the frame being prepared has been painted - the yield that lets a cheap visible
 * change (a pressed row lighting up) reach the screen before an expensive one (a salon's thread
 * mounting) holds the main thread.
 *
 * WHY TWO STEPS: a `requestAnimationFrame` callback runs BEFORE the paint of its frame, so work put
 * there is painted in the same frame as the change it was meant to follow. A task posted from inside
 * it runs after that paint. A `MessageChannel` message rather than `setTimeout(0)`: it is a task
 * with no clamp and no clock in it - the yield is ordered by the frame, never by a duration.
 *
 * A HIDDEN DOCUMENT PAINTS NOTHING and runs no frame callback, so there the work runs at once
 * rather than waiting for a frame that will not come.
 *
 * @param work what to run after the paint; it runs exactly once.
 */
export function afterNextPaint(work: () => void): void {
  if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
    work();
    return;
  }
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      work();
    };
    channel.port2.postMessage(null);
  });
}
