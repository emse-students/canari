/**
 * A FIFO cap on how many of one kind of request may be in flight at once.
 *
 * WHY A CAP CHANGES ANYTHING AT ALL. Sixty media downloads issued together do not go faster than
 * three at a time - they go SLOWER for every one of them, because a narrow link divides itself
 * between whatever is asking. Fifty-seven of those sixty are for rows nobody is looking at, and the
 * one the reader IS looking at finishes last. A cap does not reduce the work; it decides the ORDER,
 * which is the only thing that was ever wrong. Opening "Medias, liens & fichiers" mounted up to 60
 * `SharedMediaThumb`s and fired 60 full-size downloads in one frame; scrolling a chat stepped the
 * render window by 140 groups and did the same for every media row in the step.
 *
 * AND IT LEAVES ROOM FOR THE APP. Media is never what the reader is waiting for - a message, a
 * page of history, a feed is. A cap below the connection budget is what keeps one of those from
 * queueing behind a photo.
 *
 * ABORT MEANS "NEVER START", NOT "STOP". A task still WAITING for a slot is dropped and never runs,
 * which is the whole win when a reader scrolls past thirty rows: those thirty never ask. A task
 * that has already started runs to completion on purpose - the fetch behind it is shared with every
 * other holder of the same object through `mediaBlobCache`'s in-flight map, so cancelling it would
 * cancel somebody else's.
 */
/**
 * Which queue a task waits in. A `background` task is work fetched AHEAD of the reader (the reel
 * viewer's next pages, `reels/reelAhead.ts`): it takes a slot only when no foreground task is
 * waiting, and never the LAST free slot - so a request for what is on screen always finds one at
 * once, however many pages are being fetched ahead.
 */
export type GateLane = 'foreground' | 'background';

export class RequestGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly waitingBackground: (() => void)[] = [];

  /** @param limit How many tasks may run at once. */
  constructor(private readonly limit: number) {}

  /** How many tasks are running right now. Exported for the tests and for a report. */
  get inFlight(): number {
    return this.active;
  }

  /** How many are queued behind them, in both lanes. */
  get queued(): number {
    return this.waiting.length + this.waitingBackground.length;
  }

  /**
   * Runs `task` once a slot is free, and rejects with `signal.reason` if `signal` aborts first.
   *
   * A slot is COUNTED at the moment it is handed over, so a task arriving between a release and
   * the woken waiter's resumption cannot take it from under that waiter.
   *
   * @param lane `background` waits behind every foreground task and leaves one slot free
   *   ({@link GateLane}).
   * @throws whatever `task` throws, or the abort reason when the wait was abandoned.
   */
  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    lane: GateLane = 'foreground'
  ): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    const queue = lane === 'background' ? this.waitingBackground : this.waiting;

    if (this.admits(lane)) {
      this.active++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          // Leave the queue rather than taking a slot and doing nothing with it.
          const i = queue.indexOf(release);
          if (i >= 0) queue.splice(i, 1);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(release);
      });
      // The slot was counted when it was handed over; the signal may have fired since.
      if (signal?.aborted) {
        this.leave();
        throw signal.reason;
      }
    }

    try {
      return await task();
    } finally {
      this.leave();
    }
  }

  /** Whether a task of `lane` may start now, with nobody of its rank queued ahead of it. */
  private admits(lane: GateLane): boolean {
    if (lane === 'foreground') return this.active < this.limit && this.waiting.length === 0;
    return (
      this.waiting.length === 0 &&
      this.waitingBackground.length === 0 &&
      this.active < this.limit - 1
    );
  }

  private leave(): void {
    this.active--;
    this.next();
  }

  /** Hands free slots on: every foreground waiter first, then background ones, one slot kept free. */
  private next(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active++;
      this.waiting.shift()!();
    }
    while (
      this.waiting.length === 0 &&
      this.active < this.limit - 1 &&
      this.waitingBackground.length > 0
    ) {
      this.active++;
      this.waitingBackground.shift()!();
    }
  }
}

/**
 * THE ONE GATE EVERY MEDIA BYTE GOES THROUGH, whether it is a post attachment, a chat bubble, a
 * shared-media thumbnail or an avatar.
 *
 * THREE, AND THE NUMBER IS A SHARE OF THE LINK RATHER THAN A GUESS AT A LATENCY. A browser gives
 * an origin six connections over HTTP/1.1 and one multiplexed stream over HTTP/2; under either,
 * three concurrent downloads leave the app's own requests - the next page of history, the feed, a
 * message being sent - a share of the link they otherwise had to fight sixty photos for. Being
 * wrong costs a little throughput on a fast link and never a wrong answer, which is why it is a
 * constant here rather than anything adaptive.
 */
export const mediaRequestGate = new RequestGate(3);
