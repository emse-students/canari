/**
 * The metronome that draws a composed live's frames: a dedicated worker's timer, because the page's
 * own timers and `requestAnimationFrame` stop or slow to once a second while the tab is hidden, and a
 * hidden tab is where a member sharing their screen spends the live. Measured, not assumed:
 * docs/wiki/frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14.
 */

import LiveFrameClockWorker from '$lib/workers/liveFrameClock.worker?worker';

/** Calls `onTick` at a steady rate until stopped; injectable so the compositor is tested without time. */
export interface FrameClock {
  start(onTick: () => void): void;
  stop(): void;
}

/**
 * A {@link FrameClock} ticking `fps` times a second from a worker. The worker is made at the first
 * start and terminated at stop: a stopped clock holds nothing.
 */
export function workerFrameClock(fps: number): FrameClock {
  let worker: Worker | null = null;
  return {
    start(onTick) {
      worker?.terminate();
      worker = new LiveFrameClockWorker();
      worker.onmessage = () => onTick();
      worker.onerror = (event) =>
        console.error('[LIVE-STUDIO] the frame clock worker failed - no frame is drawn', event);
      worker.postMessage({ cmd: 'start', intervalMs: 1000 / fps });
      console.debug(`[LIVE-STUDIO] frame clock started at ${fps} fps (worker)`);
    },
    stop() {
      if (!worker) return;
      worker.postMessage({ cmd: 'stop' });
      worker.terminate();
      worker = null;
      console.debug('[LIVE-STUDIO] frame clock stopped');
    },
  };
}
