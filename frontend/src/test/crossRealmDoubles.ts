/**
 * The two things a browser shares between the tabs of an origin, as doubles for tests that run two
 * REALMS (two fresh imports of a module, `vi.resetModules`) in one document: a Web Locks manager and
 * a BroadcastChannel bus. Both follow the specification on the points those tests rely on: a lock
 * queue is FIFO per name, shared holders coexist, `ifAvailable` answers `null` rather than queueing,
 * `steal` is granted at once and rejects every current holder's request with an `AbortError`, and a
 * channel never delivers to the object that posted.
 */

interface Pending {
  name: string;
  mode: LockMode;
  run: () => void;
}

/** A Web Locks manager: FIFO per name, shared holders coexist, exclusive excludes everything. */
export class FakeLocks {
  private queue: Pending[] = [];
  private held: { name: string; mode: LockMode; abort: (e: unknown) => void }[] = [];

  request(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const mode = options.mode ?? 'exclusive';
      const entry = { name, mode, abort: reject };
      const run = () => {
        this.held.push(entry);
        Promise.resolve()
          .then(() => callback({ name, mode } as Lock))
          .then(resolve, reject)
          .finally(() => {
            // A stolen lock already left `held`: its callback ending releases nothing.
            const at = this.held.indexOf(entry);
            if (at >= 0) this.held.splice(at, 1);
            this.pump();
          });
      };
      if (options.steal) {
        for (const h of this.held.filter((x) => x.name === name)) {
          this.held.splice(this.held.indexOf(h), 1);
          h.abort(new DOMException('The lock was stolen', 'AbortError'));
        }
        run();
        return;
      }
      if (options.ifAvailable && !this.grantableNow(name, mode)) {
        Promise.resolve()
          .then(() => callback(null))
          .then(resolve, reject);
        return;
      }
      this.queue.push({ name, mode, run });
      this.pump();
    });
  }

  async query(): Promise<LockManagerSnapshot> {
    return { held: this.held.map(({ name, mode }) => ({ name, mode })), pending: [] };
  }

  private grantableNow(name: string, mode: LockMode): boolean {
    const queued = this.queue.some((q) => q.name === name);
    const conflict = this.held.some(
      (h) => h.name === name && (h.mode === 'exclusive' || mode === 'exclusive')
    );
    return !queued && !conflict;
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length;) {
      const r = this.queue[i]!;
      const blockedAhead = this.queue.slice(0, i).some((q) => q.name === r.name);
      const conflict = this.held.some(
        (h) => h.name === r.name && (h.mode === 'exclusive' || r.mode === 'exclusive')
      );
      if (blockedAhead || conflict) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      r.run();
    }
  }
}

/** A BroadcastChannel bus: delivers to every OTHER channel of the same name, asynchronously. */
export class FakeChannel {
  static open: FakeChannel[] = [];
  /** A suspended page: it runs no code, so it hears nothing. */
  deaf = false;
  private listeners: ((ev: MessageEvent) => void)[] = [];
  constructor(readonly name: string) {
    FakeChannel.open.push(this);
  }
  addEventListener(_type: 'message', fn: (ev: MessageEvent) => void): void {
    this.listeners.push(fn);
  }
  postMessage(data: unknown): void {
    for (const ch of FakeChannel.open) {
      if (ch === this || ch.name !== this.name || ch.deaf) continue;
      setTimeout(() => ch.listeners.forEach((fn) => fn({ data } as MessageEvent)), 0);
    }
  }
  close(): void {
    FakeChannel.open = FakeChannel.open.filter((ch) => ch !== this);
  }
}
