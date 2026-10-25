import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import type { DeliveryChannel } from '$lib/mls-client/incomingDelivery';

/** Sentinel bucket key for messages without a `groupId`. */
export const MLS_QUEUE_ORPHAN_KEY = '__no_group__';

/** Message waiting in a per-conversation MLS processing queue. */
export interface MlsQueuedMessage {
  senderId: string;
  /** The sender device the envelope names - self-asserted by the sending client, see `verifiedSender`. */
  senderDeviceId?: string;
  ciphertext: Uint8Array;
  groupId?: string;
  isWelcome: boolean;
  isCommit: boolean;
  ratchetTreeBytes?: Uint8Array;
  queuedMessageId?: string;
  queuedCreatedAt?: number;
  /**
   * The server routed this copy to this device ALONE (`queued_message.addressed`). MLS encrypts for
   * the whole group, so only this says it - read by the conversation gate of step A
   * (docs/wiki/protocols/history-answer-addressing.md, rule 5).
   */
  addressed?: boolean;
  /** Tauri: persisted control frame (e.g. `group_reset`). */
  type?: string;
  /**
   * The route of the copy that was ADMITTED - set by `enqueueMessage` alone, never by a caller,
   * because the same row can be offered by both routes and only the dedup decides which one counts.
   */
  channel?: DeliveryChannel;
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

/** One acquirer waiting for the MLS client mutex. */
interface MlsLockWaiter {
  /**
   * The bucket key of the ONE frame the drain wants to apply, or `null` for every other acquirer -
   * which is exclusive of everything, a commit and its loans included. Only a frame-scoped acquirer
   * may borrow a loan ({@link MlsPerGroupScheduler.lendMlsLockWhile}).
   */
  readonly frameKey: string | null;
  /** The group whose commit this acquirer runs, set as the mutex is GRANTED - see `committingGroup`. */
  readonly commitGroup: string | null;
  readonly grant: (release: () => void) => void;
}

/** The mutex lent by a commit to the drain while that commit's request is on the network. */
interface MlsLockLoan {
  /** The committing group: none of its frames may borrow, nor may an unaddressed one. */
  readonly groupId: string;
  /** A frame of another group is being applied under the loan right now. */
  borrowed: boolean;
  /** The network answered: no new borrower, and the commit waits for the current one to finish. */
  closing: boolean;
  /** Wakes the commit once the borrower in progress at `closing` has released. */
  reclaim: (() => void) | null;
}

/**
 * Per-`groupId` MLS message queues with round-robin scheduling across conversations.
 * Ordering within a group is preserved; only one message is processed at a time on the
 * shared MLS client (global mutex).
 *
 * ## Why the drain terminates, and why that is a proof rather than a deadline
 *
 * Every iteration of {@link drain} REMOVES exactly one message from a bucket and nothing in the
 * loop puts that message back. The only thing that ever adds to a bucket from inside the loop is
 * {@link releaseWelcomeBuffer}, which moves a buffer that is finite and can be moved at most once
 * per Welcome, since it deletes the entry as it goes. So the loop is a strict decrease over
 * "messages this scheduler holds", plus whatever genuinely NEW work arrives while it runs.
 *
 * That last clause is why elapsed time is not evidence here. A drain running for ten minutes under
 * sustained traffic is doing its job; a drain running for ten minutes on one message is frozen.
 * Only a phase that never returns tells the two apart, which is what {@link guarded} watches - and
 * it reports rather than cancels, for the reason written there.
 *
 * ## What the proof does not cover, and what that cost
 *
 * The proof is about the BUCKETS, and this class holds messages outside them:
 * {@link pendingWelcomeGroups} parks a group's frames while its Welcome is in flight, so they are
 * applied after the Welcome that makes them readable rather than before it. Two paths used to close
 * that window by DISCARDING what it held rather than releasing it:
 *
 * - a SECOND Welcome for the same group replaced the buffer array outright - and a second Welcome
 *   is ordinary (a re-add, a server re-delivery);
 * - a FAILED Welcome deleted it, on the assumption that the server would re-deliver what it held.
 *   That holds only for a frame carrying a `queuedMessageId`; a live WebSocket frame need not carry
 *   one, and for those the drop was permanent.
 *
 * Neither path logged a line, which is the part that made them survivable: a dropped frame and a
 * frame that never arrived are the same thing on screen.
 *
 * STATED PRECISELY, BECAUSE IT IS EASY TO OVERSTATE: the buffer never LEAKED, so {@link isIdle} was
 * not observably wrong - it stayed true by throwing frames away. {@link getHeldCount} now counts the
 * buffer and `isIdle` accounts for it, which makes the definition match what the mailbox barrier
 * claims of it ("nothing left to APPLY") instead of depending on a drop to stay true. What makes
 * counting it SAFE - rather than a new way to hang every barrier - is
 * {@link releaseStrandedWelcomeBuffers}: a window nothing can close is reported and released.
 *
 * ## A commit waiting on the network does not hold other conversations' frames (DUP-6)
 *
 * A commit holds the mutex from stage to merge ({@link runCommitUnderMlsLock}), and its request can
 * wait two write deadlines for an answer. While it waits it LENDS the mutex
 * ({@link lendMlsLockWhile}) to the drain, one frame at a time, for any group but its own; and from
 * the moment it holds the mutex the drain skips the frames that would have to wait for it anyway
 * ({@link isHeldBackByCommit}). A held-back frame is still pending, so the termination proof above
 * is unchanged - a pick that finds only held-back frames ends the drain, and the commit's end
 * resumes it.
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

  /**
   * The bucket the drain is applying RIGHT NOW, or `null` between frames.
   *
   * Only {@link isGroupIdle} reads it, and it is the difference between "this group has nothing
   * queued" and "this group has nothing left" - a frame that has been picked is out of its bucket
   * and not yet applied, so a group-scoped barrier that looked only at the buckets would resolve in
   * the middle of the one message it was waiting for.
   */
  private currentGroupKey: string | null = null;

  /** Waiters for ONE group's queue, by bucket key. See {@link waitUntilGroupIdle}. */
  private readonly groupIdleWaiters = new Map<string, Array<() => void>>();

  /** Whether the MLS client mutex has a holder (a loan does not change it: the commit still holds). */
  private lockHeld = false;
  /** Acquirers waiting for the mutex, in arrival order. */
  private readonly lockWaiters: MlsLockWaiter[] = [];
  /**
   * The group whose commit HOLDS the mutex ({@link runCommitUnderMlsLock}), or `null`.
   *
   * While it is set, {@link pickNext} holds back every frame that could touch that group - its own,
   * the unaddressed ones, and a group whose next frame is a Welcome (a Welcome takes the mutex
   * exclusively, so picking one would stall the drain behind the commit). Everything else can be
   * applied under the commit's loan, which is the point: see {@link lendMlsLockWhile}.
   */
  private committingGroup: string | null = null;
  /** The loan currently open, or `null`. At most one: only the commit holding the mutex lends it. */
  private loan: MlsLockLoan | null = null;

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
          `processed until this returns. pending=${this.getPendingCount()} held=${this.getHeldCount()}`
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

  /**
   * Messages parked behind a Welcome still in flight, across all groups.
   *
   * Counted SEPARATELY from {@link getPendingCount} because the two answer different questions and
   * exactly one of them is the drain loop's condition. `pending` is what this loop can pick up now;
   * `held` is work it owns and cannot pick up yet. Folding held into pending would make the loop
   * spin on messages `pickNext` cannot return.
   */
  getHeldCount(): number {
    let n = 0;
    for (const buffered of this.pendingWelcomeGroups.values()) n += buffered.length;
    return n;
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

  /**
   * No drain running, no message queued, and none parked behind a Welcome.
   *
   * The third term is the one that was missing, and it is a DEFINITION rather than a bug fix: the
   * mailbox barrier states "nothing left to apply", and a frame parked behind a Welcome is exactly
   * something left to apply. It was never observably wrong only because both paths that closed the
   * window discarded what it held - see the class docblock.
   */
  isIdle(): boolean {
    return !this.isDraining && this.getPendingCount() === 0 && this.getHeldCount() === 0;
  }

  /** Resolves when all queues are drained and no drain loop is active. */
  waitUntilIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.queueIdleWaiters.push(resolve);
    });
  }

  /**
   * Nothing left to apply FOR ONE GROUP: its buckets are empty, nothing of its is parked behind a
   * Welcome, and the drain is not in the middle of one of its frames.
   *
   * **THE ORPHAN BUCKET COUNTS TOO, and that is deliberate.** A frame the server did not tag with a
   * group lands in {@link MLS_QUEUE_ORPHAN_KEY}, and this class cannot know whether it belongs to
   * the group being asked about. Waiting for it keeps the answer honest at the cost of one bucket
   * that is normally empty - where ignoring it would make this barrier claim a completeness it
   * cannot see.
   */
  isGroupIdle(groupId: string): boolean {
    if (this.currentGroupKey === groupId || this.currentGroupKey === MLS_QUEUE_ORPHAN_KEY) {
      return false;
    }
    for (const key of [groupId, MLS_QUEUE_ORPHAN_KEY]) {
      const b = this.buckets.get(key);
      if (b && b.control.length + b.welcome.length + b.messages.length > 0) return false;
      if ((this.pendingWelcomeGroups.get(key)?.length ?? 0) > 0) return false;
    }
    return true;
  }

  /**
   * Resolves when {@link isGroupIdle} holds for this group.
   *
   * **WHY IT EXISTS RATHER THAN {@link waitUntilIdle}.** The whole-mailbox barrier answers "have I
   * applied EVERYTHING", which is what a device sending a re-encrypted bundle needs and is
   * proportional to the size of the account. A device describing its store for ONE conversation
   * needs a different fact - frames for twenty-eight other conversations cannot change this group's
   * manifest. Measured 2026-09-05: a device rejoining twenty-nine groups took **189 seconds** to
   * reach whole-mailbox idle, and answered a digest that long after it was asked; the messages
   * arrived, three minutes late, on a repair that had already been fixed twice that evening.
   */
  waitUntilGroupIdle(groupId: string): Promise<void> {
    if (this.isGroupIdle(groupId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.groupIdleWaiters.get(groupId) ?? [];
      waiters.push(resolve);
      this.groupIdleWaiters.set(groupId, waiters);
    });
  }

  /**
   * Wakes every group waiter whose group has gone idle.
   *
   * Called after each frame rather than only at the end of a drain, which is the point: a group's
   * work is usually finished long before the account's is.
   */
  private notifyGroupIdle(): void {
    // Iterated live rather than over a copy: the only entry deleted is the one being visited, which
    // a Map iterator handles by definition.
    for (const [groupId, waiters] of this.groupIdleWaiters) {
      if (!this.isGroupIdle(groupId)) continue;
      this.groupIdleWaiters.delete(groupId);
      for (const resolve of waiters) resolve();
    }
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
  acquireMlsLock(): Promise<() => void> {
    return this.acquire(null, null);
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
   * Runs ONE commit of `groupId` - stage through merge or clear - under the mutex, exclusive of
   * every other acquirer exactly as {@link runUnderMlsLock} is, and names the group while it holds:
   * that name is what lets the commit lend the mutex across its network round trip
   * ({@link lendMlsLockWhile}) and what holds that group's frames back meanwhile.
   *
   * The name is set AS THE MUTEX IS GRANTED, synchronously, not after the caller resumes: a drain
   * picking a frame in the microtask between the two would otherwise pick one of this group's.
   */
  async runCommitUnderMlsLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(null, groupId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Lends the mutex to the drain while `work` - a commit request of `groupId` on the network - is
   * pending, then takes it back before returning.
   *
   * WHY IT EXISTS (DUP-6, 2026-10-25). The commit transaction holds the mutex from stage to merge,
   * and its request may wait two 30 s write deadlines for an answer. The drain takes the same mutex
   * for every frame, so a message in ANY other conversation waited the whole minute, its ACK with
   * it, and the server's push fallback duplicated it. Nothing the network wait does touches the MLS
   * state, so nothing about a frame of ANOTHER group needs to wait for it.
   *
   * WHAT A BORROWER MAY DO, and why it is safe:
   * - only a frame-scoped acquirer ({@link acquireMlsLockForFrame}, the drain) borrows, and never for
   *   `groupId` itself nor for an unaddressed frame. Every other acquirer - a catch-up that swaps the
   *   whole client, a Welcome, a settlement, another commit - stays exclusive of the commit as before;
   * - ONE borrower at a time, so two frames are never applied concurrently: the drain's own
   *   one-frame-at-a-time rule is unchanged, only its gate moved;
   * - the staged commit and its record are already ON DISK when the first request leaves
   *   (`checkpointStageBeforeSend`), and a borrower can neither merge nor clear another group's stage.
   *   A checkpoint taken during the loan therefore holds the stage AND the borrower's ratchet - the
   *   same state a reload after the merge-less crash already had to settle;
   * - the commit takes the mutex back before it merges or clears: the reclaim waits for the borrower
   *   in progress to release, and admits no new one.
   *
   * MUST be called by the holder of {@link runCommitUnderMlsLock} for `groupId`; anything else is a
   * defect, refused before `work` starts so no request leaves under a wrong lock.
   */
  async lendMlsLockWhile<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    if (!this.lockHeld || this.committingGroup !== groupId || this.loan !== null) {
      const why =
        this.loan !== null
          ? `a loan for ${this.loan.groupId} is already open`
          : `the mutex is held for ${this.committingGroup ?? (this.lockHeld ? 'no commit' : 'nobody')}`;
      console.error(
        `[MLS_LOCK] refused to lend the MLS mutex for ${groupId}: ${why} - only the commit holding it may lend it`
      );
      throw new Error(`MLS mutex loan refused for ${groupId}: ${why}`);
    }
    const loan: MlsLockLoan = { groupId, borrowed: false, closing: false, reclaim: null };
    this.loan = loan;
    this.offerLoan();
    try {
      return await work();
    } finally {
      loan.closing = true;
      if (loan.borrowed) {
        console.log(
          `[MLS_LOCK] the commit of ${groupId} has its answer - waiting for the frame applied under its loan`
        );
        await new Promise<void>((resolve) => {
          loan.reclaim = resolve;
        });
      }
      this.loan = null;
    }
  }

  /**
   * The drain's acquisition for ONE frame of bucket `frameKey`: exclusive like
   * {@link acquireMlsLock}, except that it may borrow the mutex a commit of ANOTHER group lends
   * while its request is on the network ({@link lendMlsLockWhile}).
   */
  acquireMlsLockForFrame(frameKey: string): Promise<() => void> {
    return this.acquire(frameKey, null);
  }

  /** Whether a commit holds the mutex right now, and of which group. Diagnostics and tests. */
  get committingGroupId(): string | null {
    return this.committingGroup;
  }

  private acquire(frameKey: string | null, commitGroup: string | null): Promise<() => void> {
    return new Promise((resolve) => {
      const waiter: MlsLockWaiter = { frameKey, commitGroup, grant: resolve };
      if (!this.lockHeld && this.lockWaiters.length === 0) {
        this.grantMain(waiter);
      } else if (this.mayBorrow(waiter)) {
        this.grantBorrow(waiter);
      } else {
        this.lockWaiters.push(waiter);
      }
    });
  }

  /** Hands the mutex itself to `waiter`, naming the commit it runs - in the same synchronous step. */
  private grantMain(waiter: MlsLockWaiter): void {
    this.lockHeld = true;
    this.committingGroup = waiter.commitGroup;
    let released = false;
    waiter.grant(() => {
      if (released) return;
      released = true;
      if (this.loan !== null) {
        // `lendMlsLockWhile` closes its loan before returning, so a holder releasing with one open
        // released from inside its own loan - a defect, said as one. The loan is left to its owner.
        console.error(
          `[MLS_LOCK] the MLS mutex was released while its loan for ${this.loan.groupId} was still open`
        );
      }
      this.committingGroup = null;
      this.lockHeld = false;
      const next = this.lockWaiters.shift();
      if (next) this.grantMain(next);
    });
  }

  private mayBorrow(waiter: MlsLockWaiter): boolean {
    const loan = this.loan;
    return (
      loan !== null &&
      !loan.borrowed &&
      !loan.closing &&
      waiter.frameKey !== null &&
      waiter.frameKey !== loan.groupId &&
      waiter.frameKey !== MLS_QUEUE_ORPHAN_KEY
    );
  }

  private grantBorrow(waiter: MlsLockWaiter): void {
    const loan = this.loan!;
    loan.borrowed = true;
    console.log(
      `[MLS_LOCK] a frame of ${waiter.frameKey} is applied while the commit of ${loan.groupId} awaits its answer`
    );
    let released = false;
    waiter.grant(() => {
      if (released) return;
      released = true;
      loan.borrowed = false;
      if (loan.closing) loan.reclaim?.();
      else this.offerLoan();
    });
  }

  /** Grants the open loan to the first waiter allowed to borrow it, if any. */
  private offerLoan(): void {
    const idx = this.lockWaiters.findIndex((w) => this.mayBorrow(w));
    if (idx < 0) return;
    const [waiter] = this.lockWaiters.splice(idx, 1);
    this.grantBorrow(waiter);
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
      const held = this.pendingWelcomeGroups.get(groupId)!;
      // ONE LINE PER WINDOW, NOT PER FRAME. The window has one cause - this group's Welcome is in
      // flight - and `releaseWelcomeBuffer` already reports how many frames it held when it closes.
      // A per-frame line printed that one cause once per frame: 150 identical lines in 19 ms on a
      // Pixel 6a cold start (prod 1.2.7, 2026-10-14), ahead of the one line that carried the count.
      // The buffer itself says whether this is the window's first frame, so nothing else is kept.
      if (held.length === 0) {
        console.log(
          `[QUEUE] Buffering messages for group ${groupId} behind its Welcome - the count is reported when the Welcome ends`
        );
      }
      held.push(msg);
      return;
    }

    const bucket = this.getBucket(key);

    if (msg.isWelcome) {
      // A second Welcome for the same group used to `set(groupId, [])`, which DROPPED whatever the
      // first one was already holding - silently, and for a live frame carrying no
      // `queuedMessageId` there was nothing left to re-fetch it by. A second Welcome is a normal
      // event (a re-add, a server re-delivery), so the buffer is kept: it is released by whichever
      // Welcome completes first, and the frames were parked for that group either way.
      if (groupId && !this.pendingWelcomeGroups.has(groupId)) {
        this.pendingWelcomeGroups.set(groupId, []);
      }
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
   * Ends the Welcome buffering window for a group and puts what it held back at the front of that
   * group's queue, in arrival order.
   *
   * ONE METHOD FOR BOTH OUTCOMES, and that is the change. A Welcome that SUCCEEDED released the
   * buffer; a Welcome that FAILED used to delete it and drop its contents, on the assumption that
   * the server would re-deliver them. That assumption holds only for a frame carrying a
   * `queuedMessageId` - a live WebSocket frame need not carry one, and for those the drop was
   * permanent and silent. Re-queuing costs nothing when the group is still unknown: the pipeline
   * records the frame against that group (`unknown-group`) and re-fetches it when a Welcome finally
   * lands, which is the seam that exists for exactly this case. There is no loop - the frames are
   * pushed straight into the bucket, past {@link enqueue}, and the buffer entry is gone by then.
   *
   * @param reason What ended the window, for the log - a completed Welcome or a failed one.
   */
  releaseWelcomeBuffer(groupId: string, reason: string): void {
    const buffered = this.pendingWelcomeGroups.get(groupId);
    this.pendingWelcomeGroups.delete(groupId);
    if (!buffered?.length) return;
    const bucket = this.getBucket(this.queueKey(groupId));
    for (let i = buffered.length - 1; i >= 0; i--) {
      bucket.messages.unshift(buffered[i]);
    }
    console.log(
      `[QUEUE] ${reason}: re-queued ${buffered.length} buffered message(s) for ${groupId}`
    );
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
    // NOTHING THIS DRAIN MAY PICK: either nothing is queued, or every frame queued is held back by
    // the commit holding the mutex - which resumes them itself when it ends (`BaseMlsService`).
    if (!this.hasRunnableWork()) return;

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
        // OUT OF ITS BUCKET AND NOT YET APPLIED - the one window a group-scoped barrier would
        // otherwise resolve in. Cleared in the `finally` below so a handler that throws does not
        // leave the group permanently un-idle.
        this.currentGroupKey = picked.key;
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
          // itself is hung - so the mutex is acquired directly rather than through the wrapper,
          // and each guard covers exactly its own await.
          //
          // SCOPED TO THE FRAME'S BUCKET, so a commit of ANOTHER group waiting on the network can
          // lend the mutex to it (`lendMlsLockWhile`) rather than hold this frame for a minute.
          const release = await this.guarded(`mlsLock (${where})`, () =>
            this.acquireMlsLockForFrame(picked.key)
          );
          try {
            await this.guarded(`processMessage (${where})`, () => processMessage(msg));
          } finally {
            release();
          }
        }

        this.currentGroupKey = null;
        // AFTER EVERY FRAME, not only at the end of the drain: a group's own work is usually
        // finished long before the account's is, and that difference was three minutes on a device
        // rejoining twenty-nine conversations.
        this.notifyGroupIdle();

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
      this.releaseStrandedWelcomeBuffers();
      this.isDraining = false;
      // A FRAME THAT THREW LEFT THIS SET, and a group whose key stayed here would never read idle
      // again. The loop clears it on the ordinary path; this is the one for everything else.
      this.currentGroupKey = null;
      this.notifyIdle();
      this.notifyGroupIdle();
      console.log('[QUEUE] Drain complete');
    }
  }

  /**
   * The drain's closing invariant: no frame may be left parked with nothing able to release it.
   *
   * A buffer is opened by a Welcome and closed by that Welcome finishing, either way. So at the end
   * of a drain that emptied every bucket, a buffer that is still there has no Welcome left anywhere
   * to release it, and the frames in it would sit for the life of the tab - which is the freeze this
   * whole item is about, in the one place {@link guarded} cannot see, since nothing is awaiting.
   *
   * IT IS A PROOF, NOT A DEADLINE: the condition is "the buckets are empty and a buffer survives",
   * which cannot be true of a healthy drain at any speed. Reaching it is a defect, so it is an
   * error - and the frames are re-queued rather than dropped, which the restart guard in
   * `processQueue` then picks up.
   */
  private releaseStrandedWelcomeBuffers(): void {
    if (this.getPendingCount() > 0 || this.pendingWelcomeGroups.size === 0) return;
    const held = this.getHeldCount();
    const groups = [...this.pendingWelcomeGroups.keys()];
    console.error(
      `[QUEUE] a Welcome buffering window survived a drain that emptied every queue, on` +
        ` [${groups.join(', ')}], holding ${held} message(s) - nothing was left to release it. The` +
        ' frames it holds would never have been applied, and every LATER frame for those groups' +
        ' would have been parked behind it for the life of the tab. Released and re-queued. A' +
        ' Welcome must close the window it opened; find the path that opened one it did not close.'
    );
    for (const groupId of groups) this.releaseWelcomeBuffer(groupId, 'stranded buffer');
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
    const idx = this.findInTier(tier);
    if (idx === null) return null;
    const key = this.rrKeys[idx];
    const msg = this.buckets.get(key)![tier].shift()!;
    this.rrIndex = (idx + 1) % this.rrKeys.length;
    return { key, msg };
  }

  /** The round-robin index of the next bucket with a frame `tier` may pick now, or `null`. */
  private findInTier(tier: keyof GroupBuckets): number | null {
    const n = this.rrKeys.length;
    for (let offset = 0; offset < n; offset++) {
      const idx = (this.rrIndex + offset) % n;
      const key = this.rrKeys[idx];
      const bucket = this.buckets.get(key);
      if (!bucket || bucket[tier].length === 0) continue;
      if (this.isHeldBackByCommit(key, bucket, tier)) continue;
      return idx;
    }
    return null;
  }

  /**
   * Whether the commit holding the mutex holds this bucket's next `tier` frame back.
   *
   * THREE KINDS, each because picking it would make the drain wait for the whole commit instead of
   * applying what it can: the committing group's own frames (a frame of it - another member's commit
   * above all - must not be applied while its stage is in flight: it would clear that stage), an
   * unaddressed frame (it could be that group's), and a Welcome (its handler takes the mutex
   * exclusively) together with the frames queued behind it in its group, which it must precede.
   * Nothing is dropped: they stay in their buckets, counted as pending, and the commit's end resumes
   * them.
   */
  private isHeldBackByCommit(key: string, bucket: GroupBuckets, tier: keyof GroupBuckets): boolean {
    const committing = this.committingGroup;
    if (committing === null) return false;
    if (key === committing || key === MLS_QUEUE_ORPHAN_KEY) return true;
    if (tier === 'welcome') return true;
    if (tier === 'messages') {
      return bucket.welcome.length > 0 || bucket.messages[0]?.isWelcome === true;
    }
    return false;
  }

  /**
   * Whether a drain started now would apply anything: a frame is queued that no commit holds back.
   * The drain's restart guard reads this rather than the pending count, which a held-back frame keeps
   * above zero for the whole commit.
   */
  hasRunnableWork(): boolean {
    if (this.committingGroup === null) return this.getPendingCount() > 0;
    const tiers: Array<keyof GroupBuckets> =
      this.mode === 'tauri' ? ['control', 'welcome', 'messages'] : ['messages'];
    return tiers.some((tier) => this.findInTier(tier) !== null);
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.queueIdleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
