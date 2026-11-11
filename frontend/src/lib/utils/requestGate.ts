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
 * ABORT MEANS "NEVER START" HERE, AND "STOP" IS THE TASK'S OWN. A task still WAITING for a slot is
 * dropped and never runs, which is the whole win when a reader scrolls past thirty rows: those thirty
 * never ask. A task that has already started is the caller's to stop: the gate only frees its slot
 * when it ends. `mediaBlobCache`'s shared loads and `mediaHeadStore`'s heads hand their `fetch` the
 * same signal, so a load NOBODY holds any more is stopped on the wire too - the count of its holders
 * says nobody else's request is cancelled with it (lead decision, 2026-11-11).
 */
/**
 * Which queue a task waits in. A `background` task is work fetched AHEAD of the reader (the reel
 * viewer's next pages, `reels/reelAhead.ts`): it takes a slot only when no foreground task is
 * waiting, and never the LAST free slot - so a request for what is on screen always finds one at
 * once, however many pages are being fetched ahead.
 */
export type GateLane = 'foreground' | 'background';

/**
 * A task's lane that can be RAISED while the task waits - the cure for a priority inversion.
 *
 * Work fetched ahead waits in the background lane; when the reader reaches that page, its player
 * JOINS that same work (a head, a picture) rather than asking again - and would then wait behind
 * every foreground request queued after it, for bytes it is now watching. {@link promote} moves a
 * task still QUEUED into the foreground lane, at its tail; a task already running is unaffected (it
 * holds its slot already). Shared by the load and every joiner: the first foreground joiner raises
 * it, for good.
 */
export class GateRank {
  #lane: GateLane;
  readonly #watchers = new Set<() => void>();

  constructor(lane: GateLane) {
    this.#lane = lane;
  }

  /** The lane a task of this rank waits in now. */
  get lane(): GateLane {
    return this.#lane;
  }

  /** Moves the task to the foreground lane - once; idempotent. */
  promote(): void {
    if (this.#lane === 'foreground') return;
    this.#lane = 'foreground';
    // A snapshot: a watcher may unsubscribe itself (or another) while being told.
    for (const watcher of Array.from(this.#watchers)) watcher();
  }

  /** Told when the rank is promoted; returns the unsubscribe. The gate's own use. */
  watch(onPromote: () => void): () => void {
    this.#watchers.add(onPromote);
    return () => this.#watchers.delete(onPromote);
  }
}

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
   *   ({@link GateLane}); a {@link GateRank} may be promoted to the foreground while it waits.
   * @throws whatever `task` throws, or the abort reason when the wait was abandoned.
   */
  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    lane: GateLane | GateRank = 'foreground'
  ): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    const rank = typeof lane === 'string' ? null : lane;
    const startLane = rank ? rank.lane : (lane as GateLane);
    let queue = startLane === 'background' ? this.waitingBackground : this.waiting;

    if (this.admits(startLane)) {
      this.active++;
    } else {
      await new Promise<void>((resolve, reject) => {
        let unwatch = () => {};
        const release = () => {
          signal?.removeEventListener('abort', onAbort);
          unwatch();
          resolve();
        };
        const onAbort = () => {
          // Leave the queue rather than taking a slot and doing nothing with it.
          const i = queue.indexOf(release);
          if (i >= 0) queue.splice(i, 1);
          unwatch();
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(release);
        if (rank && queue === this.waitingBackground) {
          unwatch = rank.watch(() => {
            const i = this.waitingBackground.indexOf(release);
            if (i < 0) return;
            this.waitingBackground.splice(i, 1);
            queue = this.waiting;
            this.waiting.push(release);
            console.debug(
              '[request-gate] a queued background task was joined by the foreground - moved to its lane'
            );
            this.next();
          });
        }
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
