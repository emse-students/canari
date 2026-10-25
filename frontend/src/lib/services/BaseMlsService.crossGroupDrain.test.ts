// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
const persistMlsStructuralCheckpoint = vi.hoisted(() => vi.fn());
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: (...a: unknown[]) => persistMlsStructuralCheckpoint(...a),
  scheduleOutboundMlsPersist: () => undefined,
}));

import { BaseMlsService } from './BaseMlsService';
import {
  CommitOutcomeUnknownError,
  type PendingSubmissionRead,
} from '$lib/mls-client/commitSubmission';
import type { MlsPerGroupScheduler, MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';
import type { DeliveryChannel } from '$lib/mls-client/incomingDelivery';
import { TransportFailureError } from '$lib/utils/transportFailure';

/**
 * DUP-6 (rig, build 1.4.1-alpha.4, reproduced twice): WHILE ONE GROUP'S COMMIT REQUEST WAS
 * UNANSWERED, NO OTHER CONVERSATION'S MESSAGE WAS PROCESSED.
 *
 * The device staged an Add in group A and posted it; the answer took two write deadlines (~62 s).
 * A frame for group B arrived at once and opened its drain, then waited the whole minute for the MLS
 * mutex the commit held across its network round trip - decrypted, displayed and ACKed in the same
 * millisecond the commit's resubmission gave up, with the server's push fallback firing in between.
 *
 * These cases run the REAL `runCommitTransaction`, the REAL `processQueue` and the REAL scheduler;
 * only the platform primitives and the network are stand-ins, and the network's answer is a promise
 * the test settles by hand - every assertion is an order, never a duration.
 */

/** @see BaseMlsService.mailboxBarrier.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const A = 'group-a';
const B = 'group-b';

type Answer = { accepted: boolean; duplicate?: boolean; newEpoch?: number };

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A live frame with a queue row, so the drain acknowledges it. */
const frame = (groupId: string, qId: string): MlsQueuedMessage => ({
  senderId: 'user-b',
  ciphertext: new Uint8Array([1]),
  groupId,
  isWelcome: false,
  isCommit: false,
  queuedMessageId: qId,
});

const lost = () => new TransportFailureError(new TypeError('Failed to fetch'));

function setup() {
  const svc = new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');
  /** What happened, in the order it happened: the pipeline's decrypts and the commit's merge. */
  const order: string[] = [];
  /** group id -> its staged commit's record (the crate's rule: a merge or a clear ends it). */
  const state = new Map<string, PendingSubmissionRead>();
  const submitCommit = vi.fn<(...args: unknown[]) => Promise<Answer>>();
  const ackMessages = vi.fn(async (_ids: string[]) => undefined);
  Object.assign(svc, {
    userId: 'user-a',
    deviceId: 'web-a',
    delivery: {
      submitCommit,
      ackMessages,
      pullPendingMessagesJson: vi.fn().mockResolvedValue(undefined),
    },
    // The pipeline's decrypt: the frame is "displayed" when this runs.
    messageCallback: vi.fn(async (_sender: string, _content: Uint8Array, groupId?: string) => {
      order.push(`decrypt ${groupId}`);
      return true;
    }),
    unresolvedGroups: new Set<string>(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    getEpoch: vi.fn(() => 5),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
    pendingSubmission: vi.fn(async (g: string) => state.get(g) ?? { status: 'none' }),
    groupsWithPendingCommit: vi.fn(async () => [...state.keys()]),
    mergePendingCommit: vi.fn(async (g: string) => {
      order.push(`merge ${g}`);
      state.delete(g);
    }),
    clearPendingCommit: vi.fn(async (g: string) => {
      order.push(`clear ${g}`);
      state.delete(g);
    }),
  });
  const inner = svc as unknown as {
    messageScheduler: MlsPerGroupScheduler;
    enqueueMessage(msg: MlsQueuedMessage, channel: DeliveryChannel): void;
    runCommitTransaction(
      g: string,
      stage: (intent: Uint8Array) => Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>
    ): Promise<unknown>;
  };
  /** A stage as the crate does it: ONE call stages the commit and records it with `intent`. */
  const commit = () =>
    inner.runCommitTransaction(A, async (intent) => {
      state.set(A, {
        status: 'recorded',
        record: {
          intent,
          baseEpoch: 5,
          commit: new Uint8Array([1]),
          groupInfo: new Uint8Array([2]),
          addedIndices: [],
        },
      });
      return { commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) };
    });
  const deliver = (groupId: string, qId: string) =>
    inner.enqueueMessage(frame(groupId, qId), 'live');
  const acked = () => ackMessages.mock.calls.flatMap((c) => c[0]);
  return { svc, order, state, submitCommit, ackMessages, commit, deliver, acked, inner };
}

describe('a commit request waiting on the network (DUP-6)', () => {
  beforeEach(() => {
    persistMlsStructuralCheckpoint.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("decrypts and ACKs another group's frame while the request is unanswered, and its own group's only after the merge", async () => {
    const t = setup();
    const answer = deferred<Answer>();
    t.submitCommit.mockImplementationOnce(() => answer.promise);

    const committed = t.commit();
    await vi.waitFor(() => expect(t.submitCommit).toHaveBeenCalledTimes(1));
    // On disk before the request left, as the transaction requires - unchanged by the loan.
    expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);

    t.deliver(B, 'q-b');
    t.deliver(A, 'q-a');
    // THE ROW'S QUESTION: B's frame is decrypted AND acknowledged while A's answer is still held, so
    // nothing is left for the server's push fallback to duplicate.
    await vi.waitFor(() => expect(t.acked()).toEqual(['q-b']));
    expect(t.order).toEqual([`decrypt ${B}`]);
    expect(t.submitCommit).toHaveBeenCalledTimes(1);
    // A's own frame is held back: applying one of its frames (another member's commit above all)
    // while its stage is in flight could clear that stage.
    expect(t.inner.messageScheduler.getPendingCount()).toBe(1);

    answer.resolve({ accepted: true, newEpoch: 6 });
    await committed;
    // ...and resumed by the commit's end, after its merge.
    await vi.waitFor(() => expect(t.acked()).toEqual(['q-b', 'q-a']));
    expect(t.order).toEqual([`decrypt ${B}`, `merge ${A}`, `decrypt ${A}`]);
    expect(t.state.has(A)).toBe(false);
  });

  it('keeps an unanswered commit through two loans, and its later settlement still merges it', async () => {
    const t = setup();
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    t.submitCommit
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const committed = t.commit().catch((e: unknown) => e);
    await vi.waitFor(() => expect(t.submitCommit).toHaveBeenCalledTimes(1));
    t.deliver(B, 'q-b1');
    await vi.waitFor(() => expect(t.acked()).toEqual(['q-b1']));

    // No answer to the first request: the SAME bytes go again, under a second loan.
    first.reject(lost());
    await vi.waitFor(() => expect(t.submitCommit).toHaveBeenCalledTimes(2));
    t.deliver(B, 'q-b2');
    await vi.waitFor(() => expect(t.acked()).toEqual(['q-b1', 'q-b2']));

    second.reject(lost());
    const err = await committed;
    expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
    // KEPT, never cleared nor merged, by anything B's frames did meanwhile.
    expect(t.state.get(A)).toMatchObject({ status: 'recorded' });
    expect(t.order).toEqual([`decrypt ${B}`, `decrypt ${B}`]);

    // The settlement is a commit hold too: it lends while ITS request is pending, then merges.
    const settleAnswer = deferred<Answer>();
    t.submitCommit.mockImplementationOnce(() => settleAnswer.promise);
    const settled = t.svc.settleUnresolvedCommits([A]);
    await vi.waitFor(() => expect(t.submitCommit).toHaveBeenCalledTimes(3));
    t.deliver(B, 'q-b3');
    await vi.waitFor(() => expect(t.acked()).toEqual(['q-b1', 'q-b2', 'q-b3']));
    settleAnswer.resolve({ accepted: true, duplicate: true, newEpoch: 6 });
    await settled;

    expect(t.order).toEqual([`decrypt ${B}`, `decrypt ${B}`, `decrypt ${B}`, `merge ${A}`]);
    expect(t.state.has(A)).toBe(false);
    // One request, three times: the same bytes each time.
    const commits = t.submitCommit.mock.calls.map((c) => c[2]);
    expect(commits).toEqual([commits[0], commits[0], commits[0]]);
  });
});
