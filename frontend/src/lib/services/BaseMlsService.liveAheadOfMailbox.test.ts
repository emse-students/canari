// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseMlsService } from './BaseMlsService';
import { workspaceScope } from '$lib/mls-client/distributionScope';
import type { IncomingDeliveryMeta } from '$lib/mls-client/incomingDelivery';
import type { MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';
import { flushMacrotask } from '../../test/flush';

/**
 * A LIVE KEY-GROUP FRAME THAT OVERTAKES ITS OWN MAILBOX - through the REAL scheduler and the REAL
 * delivery dedupe, never a flag set by hand (review of #3030, B1; channel-encryption 22.2).
 *
 * The scheduler is an arrival-order FIFO per group. After a reconnect, a seed F pushed live at the
 * server's epoch is enqueued FIRST; the reconnect's pull then lists the commits and seeds the server
 * queued BEFORE it (C1, S, C2) and F's own row, which the dedupe drops because F's live copy is still
 * queued. The pull ends - the mailbox now reads "listed" - before the scheduler reaches F. Decided at
 * that moment, F looked like a frame whose commits are missing, stepped the log over C1 and C2, and S
 * was opened past `max_past_epochs` (2) or never. Stamped at its ARRIVAL, it is held instead, and
 * the pull its hold asks for lists it again BEHIND them.
 */

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {
  protected override pausePlatformSocket(): void {}
}

const GROUP = 'kg-1';
const COMMIT = 0xcc;
/** A frame: a commit, or a seed sealed at `epoch`. */
const commit = () => new Uint8Array([COMMIT]);
const seedAt = (epoch: number) => new Uint8Array([0x5e, epoch]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const row = (id: string, bytes: Uint8Array) => ({
  id,
  proto: b64(bytes),
  groupId: GROUP,
  senderId: 'peer',
  isCommit: bytes[0] === COMMIT,
});

type Internals = {
  enqueueMessage(msg: MlsQueuedMessage, channel: 'live' | 'pull'): void;
  fetchPendingMessages(): Promise<void>;
  pendingPullInFlight: Promise<void> | null;
};

function harness() {
  const tree = { epoch: 4 };
  /** What the group opened, in order - `stepped` when the log was replayed instead of the queue. */
  const opened: string[] = [];
  const pulls: Record<string, unknown>[][] = [
    // The reconnect's pull: what the server queued before F, then F's own row.
    [row('c1', commit()), row('s5', seedAt(5)), row('c2', commit()), row('f', seedAt(6))],
    // The pull F's hold asks for: F is the one row still unacknowledged.
    [row('f', seedAt(6))],
  ];
  const svc = new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');
  const scope = workspaceScope('ws-1');
  Object.assign(svc, {
    userId: 'user-a',
    isWsOpen: () => true,
    delivery: {
      ackMessages: vi.fn().mockResolvedValue(undefined),
      pullPendingMessagesJson: vi.fn(
        async ({ onPage }: { onPage: (rows: Record<string, unknown>[]) => void }) => {
          onPage(pulls.shift() ?? []);
        }
      ),
    },
    getEpoch: () => tree.epoch,
    // The tree, as MLS would answer: a commit moves it, a seed opens at its epoch or the two before.
    openDistributionFrame: vi.fn(async (_g: string, _s: string, bytes: Uint8Array) => {
      if (bytes[0] === COMMIT) {
        tree.epoch += 1;
        opened.push(`commit->${tree.epoch}`);
        return null;
      }
      const at = bytes[1];
      if (at > tree.epoch) {
        throw new Error(`Process error: epoch gap [msg_epoch=${at}, group_epoch=${tree.epoch}]`);
      }
      if (at < tree.epoch - 2) throw new Error(`past-epoch-application ${at}`);
      opened.push(`seed@${at}`);
      return new Uint8Array([at]);
    }),
    // The log: a step applies the next commit out of queue order. Recorded, so a step is visible.
    stepDistributionGroup: vi.fn(async () => {
      tree.epoch += 1;
      opened.push(`stepped->${tree.epoch}`);
      return true;
    }),
    distributionFrameHandler: vi.fn().mockResolvedValue(undefined),
  });
  (
    svc as unknown as { distributionScopeByGroup: Map<string, unknown> }
  ).distributionScopeByGroup.set(GROUP, scope);
  return { svc, inner: svc as unknown as Internals, tree, opened };
}

describe('a live key-group frame enqueued before the reconnect pull listed the mailbox', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is applied BEHIND the commits and seeds queued before it, the pull owed behind its drain', async () => {
    const { svc, inner, opened } = harness();
    // The pipeline's own hand-off (`setupMessageHandler`), gated on its FIRST frame so the pull can
    // list the mailbox - and end - before the scheduler reaches F.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    let first = true;
    svc.onMessage(async (sender, content, groupId, _w, _t, _c, meta?: IncomingDeliveryMeta) => {
      if (first) {
        first = false;
        await gate;
      }
      return svc.routeDistributionFrame(
        groupId!,
        sender,
        content,
        meta?.senderDeviceId,
        meta?.aheadOfMailbox === true
      );
    });

    // F arrives live on the new link, before any pull.
    inner.enqueueMessage(
      {
        senderId: 'peer',
        ciphertext: seedAt(6),
        groupId: GROUP,
        isWelcome: false,
        isCommit: false,
        queuedMessageId: 'f',
      },
      'live'
    );
    // The reconnect's pull is asked while F's drain runs. PULLS ARE SINGLE-FLIGHT BEHIND THE DRAIN
    // (`fetchPendingMessages`, #3035): it is owed, so the mailbox cannot read "listed" while F,
    // ahead of the rows it will list, has not been handled - the window this case was written for
    // (the pull ending first) no longer opens, and the stamp must still hold F when it does not.
    const pulled = inner.fetchPendingMessages();
    const listed = () =>
      (svc as unknown as { mailboxEmptiedByAPull: boolean }).mailboxEmptiedByAPull;
    for (let i = 0; i < 5; i++) await flushMacrotask();
    expect(listed()).toBe(false);
    expect(svc.isGroupDrained(GROUP)).toBe(false);
    expect(opened).toEqual([]);

    openGate();
    await pulled;
    for (let i = 0; i < 20 && !svc.isGroupDrained(GROUP); i++) await flushMacrotask();

    // No step of the log, and the seed sealed at 5 opened at its own epoch, before F. CONTROL: with
    // the hold decided when F is HANDLED (`live && !mailboxListedOnThisLink()`, the first cut of
    // #3030) this reads ['stepped->5', 'stepped->6', 'commit->7', 'seed@5', 'commit->8', ...] -
    // the log replayed over the queued commits, which then applied a second time out of order.
    expect(opened).toEqual(['commit->5', 'seed@5', 'commit->6', 'seed@6']);
    expect(
      (svc as unknown as { stepDistributionGroup: ReturnType<typeof vi.fn> }).stepDistributionGroup
    ).not.toHaveBeenCalled();
  });

  it('is NOT stamped when it arrives after this link listed the mailbox: its commits really are missing', async () => {
    const { svc, inner, opened } = harness();
    svc.onMessage(async (sender, content, groupId, _w, _t, _c, meta?: IncomingDeliveryMeta) =>
      svc.routeDistributionFrame(
        groupId!,
        sender,
        content,
        meta?.senderDeviceId,
        meta?.aheadOfMailbox === true
      )
    );
    Object.assign(svc, { mailboxEmptiedByAPull: true });

    inner.enqueueMessage(
      {
        senderId: 'peer',
        ciphertext: seedAt(6),
        groupId: GROUP,
        isWelcome: false,
        isCommit: false,
        queuedMessageId: 'f',
      },
      'live'
    );
    for (let i = 0; i < 20 && !svc.isGroupDrained(GROUP); i++) await flushMacrotask();

    expect(opened).toEqual(['stepped->5', 'stepped->6', 'seed@6']);
  });
});
