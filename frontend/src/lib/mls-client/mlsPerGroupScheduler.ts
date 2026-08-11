import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Sentinel bucket key for messages without a `groupId`. */
export const MLS_QUEUE_ORPHAN_KEY = '__no_group__';

/** Message waiting in a per-conversation MLS processing queue. */
export interface MlsQueuedMessage {
  senderId: string;
  ciphertext: Uint8Array;
  groupId?: string;
  isWelcome: boolean;
  isCommit: boolean;
  ratchetTreeBytes?: Uint8Array;
  queuedMessageId?: string;
  queuedCreatedAt?: number;
  /** Tauri: persisted control frame (e.g. `group_reset`). */
  type?: string;
}

/** `web`: Welcome at front of each group's message list. `tauri`: separate control/welcome tiers. */
export type MlsPerGroupQueueMode = 'web' | 'tauri';

interface GroupBuckets {
  control: MlsQueuedMessage[];
  welcome: MlsQueuedMessage[];
  messages: MlsQueuedMessage[];
}

export interface MlsPerGroupDrainHooks {
  onDrainStart?: (pendingCount: number) => void;
  onDrainEnd?: (hadWork: boolean) => void | Promise<void>;
}

/**
 * Per-`groupId` MLS message queues with round-robin scheduling across conversations.
 * Ordering within a group is preserved; only one message is processed at a time on the
 * shared MLS client (global mutex).
 */
export class MlsPerGroupScheduler {
  private readonly buckets = new Map<string, GroupBuckets>();
  private readonly rrKeys: string[] = [];
  /** Mirror set of rrKeys for O(1) lookups instead of rrKeys.includes(). */
  private readonly rrKeySet = new Set<string>();
  private rrIndex = 0;
  private isDraining = false;
  private readonly pendingWelcomeGroups = new Map<string, MlsQueuedMessage[]>();
  private readonly queueIdleWaiters: Array<() => void> = [];
  private mlsLock: Promise<void> = Promise.resolve();

  /**
   * How long any ONE await inside {@link drain} may take before it is reported as stuck, and how
   * often the report then repeats.
   *
   * It is a REPORTING deadline, not a cancellation: nothing is abandoned when it fires. A hung
   * phase keeps the drain's mutual exclusion, which is what it is for - see {@link guarded}.
   */
  private static readonly PHASE_STUCK_MS = 60_000;

  constructor(private readonly mode: MlsPerGroupQueueMode) {}

  /**
   * The ONE way to await inside {@link drain}, and the reason it exists is that there is no other
   * way to make this safe by construction.
   *
   * `isDraining` is lowered only when the whole drain - loop AND flush - has returned, so every
   * await between those two points is a potential freeze of ALL inbound traffic, in silence:
   * `enqueue` sees `draining === true`, declines to start a second drain, and the messages sit
   * there forever with nothing in the log distinguishing "still working" from "stuck". Two
   * different awaits have already done exactly that on production - a `requestAnimationFrame`
   * yield in a hidden document (WP-HIDDEN-1) and a recovery re-acquiring the MLS mutex the drain
   * already holds (WP-DRAIN-1) - and each was fixed in place while the SHAPE was left open.
   *
   * WHY IT REPORTS RATHER THAN CANCELS. Abandoning a phase on deadline would release the exclusion
   * while the flush is still running, and a second drain would then call `beginBulkIngest` across
   * a live `endBulkIngest`: a UI buffer cleared without being flushed, which is WP-ECHO-1's exact
   * failure and a strictly worse one - a freeze loses nothing durable, a lost buffer does. So the
   * flush stays inside the window and the deadline buys the only thing it safely can: evidence.
   *
   * It repeats rather than firing once because the elapsed time IS the diagnosis. A single line
   * says a phase was slow; a line every minute for twenty minutes says it will never return.
   */
  private async guarded<T>(label: string, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      console.error(
        `[QUEUE] STUCK in ${label} for ${Math.round((Date.now() - startedAt) / 1000)}s - ` +
          `the inbound queue is frozen: every message arriving now is enqueued and will not be ` +
          `processed until this returns. pending=${this.getPendingCount()}`
      );
    }, MlsPerGroupScheduler.PHASE_STUCK_MS);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /** Whether the drain loop is currently running. */
  get draining(): boolean {
    return this.isDraining;
  }

  /** Total messages waiting across all groups. */
  getPendingCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) {
      n += b.control.length + b.welcome.length + b.messages.length;
    }
    return n;
  }

  /** Queue stats for logging. */
  getStats(): { groups: number; control: number; welcome: number; messages: number } {
    let control = 0;
    let welcome = 0;
    let messages = 0;
    for (const b of this.buckets.values()) {
      control += b.control.length;
      welcome += b.welcome.length;
      messages += b.messages.length;
    }
    return { groups: this.rrKeys.length, control, welcome, messages };
  }

  isIdle(): boolean {
    return !this.isDraining && this.getPendingCount() === 0;
  }

  /** Resolves when all queues are drained and no drain loop is active. */
  waitUntilIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.queueIdleWaiters.push(resolve);
    });
  }

  /**
   * Acquires the global MLS client mutex and resolves with its release function.
   * Use when a single logical operation spans several awaits (e.g. a paged catch-up
   * decrypt session) and must keep exclusive access to the client the whole time.
   * The returned release is idempotent; the caller MUST call it (typically in `finally`).
   *
   * Non-reentrant: the lock has no notion of "current holder" in async JS, so a depth
   * counter would grant access to any concurrent acquirer while the lock is held - not just
   * a genuinely nested one. History catch-up (createDecryptSession) is decoupled from the
   * drain via a fire-and-forget onWelcomeProcessed callback, so it queues behind the drain
   * here rather than re-entering; never re-acquire while already holding the lock.
   */
  async acquireMlsLock(): Promise<() => void> {
    const prev = this.mlsLock;
    let release!: () => void;
    this.mlsLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /**
   * Runs `fn` under the global MLS client mutex so WASM/native state is never mutated concurrently.
   */
  async runUnderMlsLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireMlsLock();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Enqueues a message. Welcome handling and per-group buffering match prior global-queue semantics.
   */
  enqueue(msg: MlsQueuedMessage): void {
    const groupId = msg.groupId;
    const key = this.queueKey(groupId);

    if (msg.type === 'group_reset' && this.mode === 'tauri') {
      this.getBucket(key).control.push(msg);
      return;
    }

    if (groupId && this.pendingWelcomeGroups.has(groupId) && !msg.isWelcome) {
      console.log(`[QUEUE] Buffering message for group ${groupId} (Welcome in progress)`);
      this.pendingWelcomeGroups.get(groupId)!.push(msg);
      return;
    }

    const bucket = this.getBucket(key);

    if (msg.isWelcome) {
      if (groupId) this.pendingWelcomeGroups.set(groupId, []);
      if (this.mode === 'tauri') {
        bucket.welcome.push(msg);
      } else {
        bucket.messages.unshift(msg);
      }
      return;
    }

    bucket.messages.push(msg);
  }

  /**
   * Re-injects messages buffered during Welcome processing at the front of the group's queue.
   */
  reinjectAfterWelcome(groupId: string): void {
    const buffered = this.pendingWelcomeGroups.get(groupId);
    if (!buffered?.length) {
      this.pendingWelcomeGroups.delete(groupId);
      return;
    }
    this.pendingWelcomeGroups.delete(groupId);
    const bucket = this.getBucket(this.queueKey(groupId));
    for (let i = buffered.length - 1; i >= 0; i--) {
      bucket.messages.unshift(buffered[i]);
    }
    console.log(
      `[QUEUE] Welcome complete, re-injected ${buffered.length} buffered message(s) for ${groupId}`
    );
  }

  /** Clears Welcome buffering state after Welcome failure (messages may be re-fetched from server). */
  clearWelcomePending(groupId: string): void {
    this.pendingWelcomeGroups.delete(groupId);
  }

  hasWelcomePending(groupId: string): boolean {
    return this.pendingWelcomeGroups.has(groupId);
  }

  /**
   * Drains all per-group queues in round-robin order (control → welcome → messages per tier).
   */
  async drain(
    processMessage: (msg: MlsQueuedMessage) => Promise<void>,
    hooks?: MlsPerGroupDrainHooks
  ): Promise<void> {
    if (this.isDraining) {
      console.log('[QUEUE] Drain already running - skipped');
      return;
    }

    const pendingAtStart = this.getPendingCount();
    if (pendingAtStart === 0) return;

    this.isDraining = true;
    const stats = this.getStats();
    console.log(
      `[QUEUE] Drain start (mode=${this.mode}) groups=${stats.groups} control=${stats.control} welcome=${stats.welcome} messages=${stats.messages}`
    );

    try {
      hooks?.onDrainStart?.(pendingAtStart);

      while (this.getPendingCount() > 0) {
        const picked = this.pickNext();
        if (!picked) break;

        const { msg } = picked;
        const where = `group=${msg.groupId ?? 'unknown'}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`;
        // Welcome messages self-manage the MLS lock: their handler runs the network
        // preamble (terminal-group resolution, recovery checks) unlocked and only holds the
        // lock around the contiguous WASM critical section. Auto-locking them here would
        // keep the mutex held across those round-trips and starve catch-up / key-package work.
        //
        // Both branches go through `guarded`, and so does everything else awaited in this method:
        // an unguarded await here is the freeze this class has already shipped twice.
        if (msg.isWelcome) {
          await this.guarded(`processMessage (Welcome, ${where})`, () => processMessage(msg));
        } else {
          // The ACQUISITION is guarded separately from the work, and the two must not nest:
          // wrapping `runUnderMlsLock` whole made a hung handler report BOTH labels, which is
          // exactly the ambiguity the split exists to remove. They fail differently and point at
          // different code - waiting on the mutex means something outside this loop is holding it
          // (WP-DRAIN-1's recovery re-entering it), a slow `processMessage` means the handler
          // itself is hung - so `acquireMlsLock` is called directly rather than through the
          // wrapper, and each guard covers exactly its own await.
          const release = await this.guarded(`mlsLock (${where})`, () => this.acquireMlsLock());
          try {
            await this.guarded(`processMessage (${where})`, () => processMessage(msg));
          } finally {
            release();
          }
        }

        if (this.getPendingCount() > 0) {
          await this.guarded('yieldToMainThread', () => yieldToMainThread());
        }
      }
    } finally {
      try {
        // The flush sits in front of `isDraining = false` and cannot be moved behind it (see
        // `guarded`), so it is the single most dangerous await in the class.
        await this.guarded('onDrainEnd', async () => {
          await hooks?.onDrainEnd?.(pendingAtStart > 0);
        });
      } catch (e) {
        console.error('[QUEUE] onDrainEnd failed:', e);
      }
      this.isDraining = false;
      this.notifyIdle();
      console.log('[QUEUE] Drain complete');
    }
  }

  private queueKey(groupId?: string): string {
    return groupId ?? MLS_QUEUE_ORPHAN_KEY;
  }

  private getBucket(key: string): GroupBuckets {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { control: [], welcome: [], messages: [] };
      this.buckets.set(key, bucket);
      if (!this.rrKeySet.has(key)) {
        this.rrKeys.push(key);
        this.rrKeySet.add(key);
      }
    }
    return bucket;
  }

  private pruneEmptyKeys(): void {
    for (let i = this.rrKeys.length - 1; i >= 0; i--) {
      const key = this.rrKeys[i];
      const b = this.buckets.get(key);
      if (!b || b.control.length + b.welcome.length + b.messages.length === 0) {
        this.rrKeys.splice(i, 1);
        this.rrKeySet.delete(key);
        this.buckets.delete(key);
      }
    }
    if (this.rrIndex >= this.rrKeys.length) {
      this.rrIndex = 0;
    }
  }

  /** Round-robin pick: control tier, then welcome, then application messages. */
  private pickNext(): { key: string; msg: MlsQueuedMessage } | null {
    if (this.rrKeys.length === 0) return null;

    const tiers: Array<keyof GroupBuckets> =
      this.mode === 'tauri' ? ['control', 'welcome', 'messages'] : ['messages'];

    for (const tier of tiers) {
      const picked = this.pickFromTier(tier);
      if (picked) {
        this.pruneEmptyKeys();
        return picked;
      }
    }

    this.pruneEmptyKeys();
    return null;
  }

  private pickFromTier(tier: keyof GroupBuckets): { key: string; msg: MlsQueuedMessage } | null {
    const n = this.rrKeys.length;
    if (n === 0) return null;

    for (let offset = 0; offset < n; offset++) {
      const idx = (this.rrIndex + offset) % n;
      const key = this.rrKeys[idx];
      const bucket = this.buckets.get(key);
      if (!bucket || bucket[tier].length === 0) continue;

      const msg = bucket[tier].shift()!;
      this.rrIndex = (idx + 1) % n;
      return { key, msg };
    }
    return null;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.queueIdleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

/** Maps a queue bucket key back to an optional MLS group id. */
export function groupIdFromQueueKey(key: string): string | undefined {
  return key === MLS_QUEUE_ORPHAN_KEY ? undefined : key;
}
