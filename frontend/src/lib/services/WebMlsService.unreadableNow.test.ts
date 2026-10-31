const loadAndInitWasm = vi.hoisted(() => vi.fn());

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm,
  migrateLegacyMlsStateBlob: vi.fn(),
}));

import { SavedStateUnopenedError } from '$lib/mls-client';
import { MlsStateUnreadableNowError, MlsStateVerdictError } from '$lib/mls-client/mlsStateSeal';
import { MLS_STATE_UNREADABLE_NOW_READS, WebMlsService } from './WebMlsService';

/**
 * A STATE WEBCRYPTO COULD NOT OPEN RIGHT NOW IS RE-READ, NEVER REPLACED.
 *
 * WebKit names an engine fault (memory pressure on a ~19 MB state) and a failed AES-GCM tag with the
 * same `OperationError`. The web opener used to call it `STATE_ALTERED`, which `init` answers with
 * an IRREVERSIBLE device identity rotation even under `noFreshStart`. Now it is
 * `MlsStateUnreadableNowError`: the load reads the state a bounded number of times, and what still
 * fails stops the login with the blob untouched - with or without `noFreshStart`.
 */
const unreadable = () =>
  new MlsStateUnreadableNowError(
    19 * 1024 * 1024,
    'OperationError',
    true,
    new DOMException('engine', 'OperationError')
  );

function makeCtx() {
  const ctx = {
    userId: '',
    deviceId: 'web-bob',
    stateWasExpected: true,
    client: null as unknown,
    delivery: { userId: '', deviceId: '' },
    freshStart: false,
    resolveDeviceId: vi.fn().mockResolvedValue('web-bob'),
    loadStateWithKey: WebMlsService.prototype['loadStateWithKey'],
    classifyStateLoadFailure: WebMlsService.prototype['classifyStateLoadFailure'],
    rotateDeviceIdentity: vi.fn().mockResolvedValue('rotated'),
  };
  return ctx;
}

const initImpl = (ctx: unknown, state?: Uint8Array, opts?: unknown): Promise<void> =>
  (
    WebMlsService.prototype as unknown as {
      _initImpl(u: string, k: string, s?: Uint8Array, o?: unknown): Promise<void>;
    }
  )._initImpl.call(ctx, 'bob', 'bobs-key', state, opts);

describe('WebMlsService - a state unreadable right now', () => {
  beforeEach(() => {
    loadAndInitWasm.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each([{ noFreshStart: true }, {}])(
    'never rotates the identity, keeps the blob, and says so typed (%o)',
    async (opts) => {
      loadAndInitWasm.mockRejectedValue(unreadable());
      const ctx = makeCtx();

      const failure = await initImpl(ctx, new Uint8Array([1, 2, 3]), opts).catch((e) => e);

      expect(failure).toBeInstanceOf(SavedStateUnopenedError);
      expect((failure as SavedStateUnopenedError).reason).toBe('unreadable_now');
      expect(ctx.rotateDeviceIdentity).not.toHaveBeenCalled();
      expect(loadAndInitWasm).toHaveBeenCalledTimes(MLS_STATE_UNREADABLE_NOW_READS);
    }
  );

  it('opens on a re-read when the engine fault was transient', async () => {
    const client = { tag: 'opened' };
    loadAndInitWasm.mockRejectedValueOnce(unreadable()).mockResolvedValueOnce(client);
    const ctx = makeCtx();

    await initImpl(ctx, new Uint8Array([1, 2, 3]), { noFreshStart: true });

    expect(ctx.client).toBe(client);
    expect(loadAndInitWasm).toHaveBeenCalledTimes(2);
    expect(ctx.rotateDeviceIdentity).not.toHaveBeenCalled();
  });

  it('CONTROL: an alteration mls-core PROVED still rotates, read once', async () => {
    // What separates the two classes is the deterministic reader's verdict, not the engine's.
    loadAndInitWasm.mockRejectedValue(
      new MlsStateVerdictError('STATE_ALTERED', 'judged', unreadable())
    );
    const ctx = makeCtx();

    await initImpl(ctx, new Uint8Array([1, 2, 3]), { noFreshStart: true });

    expect(loadAndInitWasm).toHaveBeenCalledTimes(1);
    expect(ctx.rotateDeviceIdentity).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['STATE_KEY_MISMATCH', 'rotated'],
    ['STATE_UNDECRYPTABLE', 'undecryptable'],
    ['IDENTITY_MISMATCH', 'mismatch'],
    ['STATE_ALTERED', 'altered'],
  ] as const)('classifies the verdict %s by its TYPE as %s', (code, failure) => {
    const ctx = makeCtx();
    // The message is overwritten so only the type can carry the verdict.
    const error = new MlsStateVerdictError(code, 'judged', unreadable());
    error.message = 'no code in this text';
    expect(ctx.classifyStateLoadFailure(error)).toBe(failure);
  });
});
