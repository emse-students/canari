// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
const persistMlsStructuralCheckpoint = vi.hoisted(() => vi.fn());
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: (...a: unknown[]) => persistMlsStructuralCheckpoint(...a),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import {
  CommitOutcomeUnknownError,
  type PendingSubmissionRead,
} from '$lib/mls-client/commitSubmission';
import {
  DeliveryRefusedRenewedTokenError,
  DeliveryRenewalFailedError,
  MlsDeliveryApi,
} from '$lib/mls-client/mlsDeliveryApi';
import { RefreshFailedError, SessionExpiredError } from '$lib/stores/auth';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { plainCommitLock } from '$lib/mls-client/test/fixtures/plainCommitLock';

/**
 * AN ADD WHOSE COMMIT IS ANSWERED 401 IS MERGED ONCE, NEVER LOST, AND NEVER A LOGOUT BY ITSELF.
 *
 * The dev campaign's TOK-1 armed one 401 on `POST /api/mls/commit`: the client logged the admits,
 * then `ApiRefusalError (401)`, cleared the staged Add and left the group at its old epoch. A 401 is
 * the auth guard's answer before the gate, so the SAME bytes go again after a renewal
 * (`renewOn401.ts`), and the transaction sees one answer and merges once. A renewed token refused too
 * is a typed failed request (`DeliveryRefusedRenewedTokenError`), never a logout. TOK-2 is the renewal
 * failing as a transport failure: no answer, so the commit's outcome is unknown and its stage is
 * KEPT for the settle that already owns that case - never cleared, never a logout.
 *
 * The real `MlsDeliveryApi` over a scripted `fetch`, and the real transaction seams of
 * `BaseMlsService`; the platform's staged commit and its record are modelled by `state`.
 */

const U = 'user-a';
const D = 'web-a';
const G = 'g-1';
const ACCEPTED = { accepted: true, newEpoch: 6 };

const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;

function answer(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ctx(fetchImpl: ReturnType<typeof vi.fn>, refreshToken: ReturnType<typeof vi.fn>) {
  const state = new Map<string, PendingSubmissionRead>();
  const delivery = new MlsDeliveryApi({
    historyUrl: 'https://delivery.test',
    getToken: async () => 'stale',
    refreshToken: refreshToken as () => Promise<string>,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  delivery.userId = U;
  delivery.deviceId = D;
  const c: Record<string, unknown> = {
    userId: U,
    deviceId: D,
    state,
    delivery,
    ...plainCommitLock,
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    getEpoch: vi.fn(() => 5),
    exportRatchetTree: vi.fn().mockResolvedValue(new Uint8Array([7])),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
    unresolvedGroups: new Set<string>(),
    owedWelcomes: vi.fn(async () => []),
    pendingSubmission: vi.fn(async (g: string) => state.get(g) ?? { status: 'none' }),
    groupsWithPendingCommit: vi.fn(async () => [...state.keys()]),
    // The key the merged commit gives this device's leaf, which the ledger names it by.
    ownLeafKey: vi.fn(async () => 'k-leaf'),
    mergePendingCommit: vi.fn(async (g: string) => {
      state.delete(g);
    }),
    clearPendingCommit: vi.fn(async (g: string) => {
      state.delete(g);
    }),
  };
  for (const name of [
    'runCommitTransaction',
    'settleUnresolvedLocked',
    'escalateUnreadableSubmission',
    'submitRecorded',
    'resubmitUnresolved',
    'awaitCommitCheckpoint',
    'checkpointStageBeforeSend',
    'mergeSettled',
    'mergeAccepted',
    'noteOwnLeafReplaced',
    'deliverOwedWelcomes',
    'knownUnresolvedGroups',
    'settleUnresolvedCommits',
  ]) {
    c[name] = proto[name];
  }
  return c as unknown as Record<string, ReturnType<typeof vi.fn>> & {
    state: Map<string, PendingSubmissionRead>;
    unresolvedGroups: Set<string>;
    runCommitTransaction(
      g: string,
      stage: (intent: Uint8Array) => Promise<unknown>,
      opts?: Record<string, unknown>
    ): Promise<unknown>;
    settleUnresolvedCommits(groupIds?: string[]): Promise<void>;
  };
}

/** A stage as the crate does it: ONE call stages the commit and records it with `intent`. */
const run = (c: ReturnType<typeof ctx>) =>
  c.runCommitTransaction(
    G,
    async (intent: Uint8Array) => {
      c.state.set(G, {
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
    },
    { removes: [{ userId: 'user-z' }] }
  );

const commitCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter((call) => String(call[0]).endsWith('/api/mls/commit'));

beforeEach(() => {
  localStorage.clear();
  persistMlsStructuralCheckpoint.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('runCommitTransaction - a commit answered 401', () => {
  it('TOK-1: renews, sends the same bytes again, and merges ONCE', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(answer(401))
      .mockResolvedValueOnce(answer(200, ACCEPTED));
    const refresh = vi.fn().mockResolvedValue('fresh');
    const c = ctx(f, refresh);
    await run(c);
    expect(refresh).toHaveBeenCalledTimes(1);
    const calls = commitCalls(f);
    expect(calls).toHaveLength(2);
    expect(String((calls[1][1] as RequestInit).body)).toBe(
      String((calls[0][1] as RequestInit).body)
    );
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.state.has(G)).toBe(false);
  });

  it('a 401 on the renewed token too: a typed failed request, the stage cleared (nothing reached the gate), no logout, no resubmission', async () => {
    const f = vi.fn().mockImplementation(async () => answer(401));
    const refresh = vi.fn().mockResolvedValue('fresh');
    const c = ctx(f, refresh);
    const err = await run(c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryRefusedRenewedTokenError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect(commitCalls(f)).toHaveLength(2);
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.unresolvedGroups.has(G)).toBe(false);
  });

  it('the same refusal on a RESUBMISSION says nothing of the first request: kept as unknown', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Failed to fetch')))
      .mockImplementation(async () => answer(401));
    const refresh = vi.fn().mockResolvedValue('fresh');
    const c = ctx(f, refresh);
    const err = await run(c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.state.get(G)).toMatchObject({ status: 'recorded' });
    expect(c.unresolvedGroups.has(G)).toBe(true);
  });

  // The server ANSWERED 401 before the gate, so the bytes never reached it, whatever the renewal
  // then did: the stage is cleared at once, never resubmitted into the same 401 and kept as unknown.
  it.each([
    [
      'TOK-2: a renewal nobody answered',
      new TransportFailureError(new TypeError('Failed to fetch')),
    ],
    ['a renewal answered 502', new RefreshFailedError(502)],
  ])(
    '%s after a 401 refuses the commit definitively - the stage cleared, no resubmission, no logout',
    async (_n, failure) => {
      const f = vi.fn().mockImplementation(async () => answer(401));
      const refresh = vi.fn().mockRejectedValue(failure);
      const c = ctx(f, refresh);
      const err = await run(c).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeliveryRenewalFailedError);
      expect((err as DeliveryRenewalFailedError).renewalFailure).toBe(failure);
      expect(err).not.toBeInstanceOf(SessionExpiredError);
      expect(commitCalls(f)).toHaveLength(1);
      expect(c.mergePendingCommit).not.toHaveBeenCalled();
      expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
      expect(c.unresolvedGroups.has(G)).toBe(false);
      expect(
        vi
          .mocked(console.warn)
          .mock.calls.some((call) => String(call[0]).includes('no answer to the commit'))
      ).toBe(false);
    }
  );
});
