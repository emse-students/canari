/**
 * THE CLOCK OF A COMPOSED LIVE (owner, 2026-11-14): posts `tick` at the rate the page asks, from a
 * DEDICATED WORKER because a worker's timers keep their rate when the page is hidden - and a hidden
 * page is the normal state of a screen share. Measured on Chrome (Windows, 2026-11-14, a real tab
 * hidden 90 s and 7 min): the page's own `setInterval` fell to 1 per second and
 * `requestAnimationFrame` to 0, while this worker's ticks stayed at 30 per second
 * (docs/wiki/frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14).
 *
 * It knows nothing of canvases or media: it is a metronome, so it imports nothing.
 */

/** What the page sends: start ticking every `intervalMs`, or stop. */
type ClockCommand = { cmd: 'start'; intervalMs: number } | { cmd: 'stop' };

let timer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (event: MessageEvent<ClockCommand>) => {
  const command = event.data;
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (command.cmd === 'start') {
    timer = setInterval(() => self.postMessage('tick'), command.intervalMs);
  }
};
