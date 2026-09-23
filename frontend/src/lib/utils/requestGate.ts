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
export class RequestGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  /** @param limit How many tasks may run at once. */
  constructor(private readonly limit: number) {}

  /** How many tasks are running right now. Exported for the tests and for a report. */
  get inFlight(): number {
    return this.active;
  }

  /** How many are queued behind them. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Runs `task` once a slot is free, and rejects with `signal.reason` if `signal` aborts first.
   *
   * @throws whatever `task` throws, or the abort reason when the wait was abandoned.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw signal.reason;

    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          // Leave the queue rather than taking a slot and doing nothing with it.
          const i = this.waiting.indexOf(release);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(release);
      });
      // The signal may have fired between the slot being handed over and this line.
      if (signal?.aborted) {
        this.next();
        throw signal.reason;
      }
    }

    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.next();
    }
  }

  private next(): void {
    if (this.active >= this.limit) return;
    this.waiting.shift()?.();
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
