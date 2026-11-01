// @vitest-environment happy-dom
const migrateLegacyMlsStateBlob = vi.hoisted(() => vi.fn());
const saveMlsState = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn(),
  migrateLegacyMlsStateBlob,
}));
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveMlsState,
}));

import { WebMlsService } from './WebMlsService';
import { SavedStateUnopenedError } from '$lib/mls-client';
import { MlsStateWriteRefusedError } from '$lib/utils/hex';
import { MlsStateVerdictError } from '$lib/mls-client/mlsStateSeal';

// THE CODES `mls-core` THROWS, not the sentences it used to. Both are this crate's own throws and
// both are typed since 2026-09-08, because the classifier that routes on them had a default arm
// that gave every unrecognised failure the diagnosis "your PIN was changed on another device".
// A fixture carrying the old prose now classifies as `unknown` - which is the point of the change,
// and is what these two lines being wrong looked like.
const UNOPENABLE = new MlsStateVerdictError('STATE_UNDECRYPTABLE', 'aead::Error');
const MISMATCH = new MlsStateVerdictError(
  'IDENTITY_MISMATCH',
  'expected u:web-u-new but state contains u:web-u-old'
);
// The two halves a FRAMED blob's fingerprint separates (step 2, 2026-10-17).
const ROTATED = new MlsStateVerdictError(
  'STATE_KEY_MISMATCH',
  "the state's header names a different device key"
);
const ALTERED = new MlsStateVerdictError(
  'STATE_ALTERED',
  'v2 AES-GCM tag did not verify under the right key'
);

/** Asserts `init` paused for the old PIN, typed, with the cause the login reads. */
async function expectPaused(run: Promise<void>, reason: string): Promise<void> {
  const err = await run.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(SavedStateUnopenedError);
  expect((err as SavedStateUnopenedError).reason).toBe(reason);
}

/**
 * Drives `_initImpl` against stubbed primitives. Only the members it touches are provided, so a
 * new dependency shows up as an explicit failure rather than a silent pass.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: '',
    deviceId: 'web-u-new',
    delivery: { userId: '', deviceId: '' },
    freshStart: false,
    resolveDeviceId: vi.fn().mockResolvedValue('web-u-new'),
    loadStateWithKey: vi.fn().mockResolvedValue(undefined),
    classifyStateLoadFailure: WebMlsService.prototype['classifyStateLoadFailure'],
    generateDeviceId: vi.fn().mockReturnValue('web-u-fresh'),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([7])),
    deleteDevice: vi.fn().mockResolvedValue(undefined),
    endDocumentAfterRefusedRotation: vi.fn(),
    // A rotation drops the burns owed to epochs ahead of the state, with the ledger.
    owedSendBurns: new Map(),
    unprovenSendRatchets: new Set(),
    owedBurnInFlight: new Map(),
    sendRatchetsNotDurable: WebMlsService.prototype['sendRatchetsNotDurable'],
    // Real implementations, not mocks: the fresh-start assertions below (new id persisted, old
    // device deleted) are assertions ABOUT the rotation, so stubbing it would test nothing.
    rotateDeviceIdentity: WebMlsService.prototype['rotateDeviceIdentity'],
    // The rotation's socket seams (`BaseMlsService.socketRotation.test.ts` owns them): no socket here.
    reopenGatewaySocketAfterRotation: vi.fn(),
    retireAbandonedIds: WebMlsService.prototype['retireAbandonedIds'],
    deleteAbandonedDevice: WebMlsService.prototype['deleteAbandonedDevice'],
    gatewaySocketSettled: WebMlsService.prototype['gatewaySocketSettled'],
    isWsOpen: () => false,
    socketStepsPending: 0,
    // BOTH HALVES OF THE CHECKPOINT, for the same reason. `persistCheckpoint` is concrete in
    // `BaseMlsService` and carries the send-ledger pairing; `writeCheckpoint` is the platform half
    // it delegates to. Stubbing either would test the rotation against a checkpoint that is not the
    // one production runs.
    persistCheckpoint: WebMlsService.prototype['persistCheckpoint'],
    writeCheckpoint: WebMlsService.prototype['writeCheckpoint'],
    ...overrides,
  };
}

const initImpl = (
  ctx: unknown,
  state?: Uint8Array,
  opts?: { noFreshStart?: boolean; legacyPin?: string }
): Promise<void> =>
  (
    WebMlsService.prototype as unknown as {
      _initImpl(u: string, k: string, s?: Uint8Array, o?: unknown): Promise<void>;
    }
  )._initImpl.call(ctx, 'u', 'key-b64', state, opts);

describe('WebMlsService._initImpl legacy migration', () => {
  const stored = new Uint8Array([1, 2, 3]);
  const resealed = new Uint8Array([4, 5, 6]);

  beforeEach(() => {
    migrateLegacyMlsStateBlob.mockReset();
    saveMlsState.mockClear();
    localStorage.clear();
  });

  it('re-seals a legacy snapshot, loads it and persists it', async () => {
    const ctx = makeCtx({
      loadStateWithKey: vi.fn().mockRejectedValueOnce(UNOPENABLE).mockResolvedValueOnce(undefined),
    });
    migrateLegacyMlsStateBlob.mockResolvedValue(resealed);

    await initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' });

    expect(ctx.loadStateWithKey).toHaveBeenNthCalledWith(2, 'key-b64', resealed);
    expect(saveMlsState).toHaveBeenCalledWith('u', resealed);
    // The device identity survives a migration - nothing was discarded.
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
    expect(ctx.deviceId).toBe('web-u-new');
  });

  it('falls back to a fresh start when the migrated snapshot names another device', async () => {
    // The regression this guards: the second load lives inside the first catch, so its mismatch
    // used to escape init entirely and surfaced as a raw "Credential identity mismatch" instead
    // of the fresh start that actually resolves it.
    const ctx = makeCtx({
      loadStateWithKey: vi
        .fn()
        .mockRejectedValueOnce(UNOPENABLE)
        .mockRejectedValueOnce(MISMATCH)
        .mockResolvedValueOnce(undefined),
    });
    migrateLegacyMlsStateBlob.mockResolvedValue(resealed);

    await expect(
      initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' })
    ).resolves.toBeUndefined();

    // A mismatch is not repairable by any PIN, so noFreshStart must NOT hold it back.
    expect(ctx.generateDeviceId).toHaveBeenCalled();
    expect(localStorage.getItem('mls_device_id_u')).toBe('web-u-fresh');
    expect(ctx.deleteDevice).toHaveBeenCalledWith('u', 'web-u-new', 'retired');
  });

  /**
   * THE ROTATION'S WRITE REFUSED (2026-10-21): another document wrote this account's state after this
   * one loaded, so the fresh identity is on no disk. Moving the shared id, or deleting the old device
   * the other document may be serving, would make a refused write permanent damage - init fails
   * instead, with every durable side effect untouched.
   */
  it('FAILS init, typed, with the old id kept everywhere, when the rotation checkpoint is refused', async () => {
    const ctx = makeCtx({
      loadStateWithKey: vi
        .fn()
        .mockRejectedValueOnce(UNOPENABLE)
        .mockRejectedValueOnce(MISMATCH)
        .mockResolvedValueOnce(undefined),
    });
    migrateLegacyMlsStateBlob.mockResolvedValue(resealed);
    localStorage.setItem('mls_device_id_u', 'web-u-new');
    saveMlsState.mockResolvedValueOnce('stale');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failure = await initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' }).catch(
      (e: unknown) => e
    );
    const said = error.mock.calls.map((c) => String(c[0]));
    error.mockRestore();

    expect(failure).toBeInstanceOf(MlsStateWriteRefusedError);
    expect(said.some((s) => s.includes('rotation ABORTED'))).toBe(true);
    expect(localStorage.getItem('mls_device_id_u')).toBe('web-u-new');
    // Init fails, so the login releases this client; the reload is the revocation path's alone.
    expect(ctx.endDocumentAfterRefusedRotation).not.toHaveBeenCalled();
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
  });

  it('still offers old-PIN recovery when the blob is not a legacy envelope', async () => {
    const ctx = makeCtx({ loadStateWithKey: vi.fn().mockRejectedValue(UNOPENABLE) });
    migrateLegacyMlsStateBlob.mockResolvedValue(null);

    await expectPaused(
      initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' }),
      'undecryptable'
    );
    expect(ctx.generateDeviceId).not.toHaveBeenCalled();
  });

  it('does not attempt a migration without a PIN (biometric and vault paths)', async () => {
    const ctx = makeCtx({ loadStateWithKey: vi.fn().mockRejectedValue(UNOPENABLE) });

    await expectPaused(initImpl(ctx, stored, { noFreshStart: true }), 'undecryptable');
    expect(migrateLegacyMlsStateBlob).not.toHaveBeenCalled();
  });

  it('pauses a state framed under ANOTHER key as `rotated` - the old PIN opens it, so nothing is rotated', async () => {
    const ctx = makeCtx({ loadStateWithKey: vi.fn().mockRejectedValue(ROTATED) });

    await expectPaused(initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' }), 'rotated');
    // A framed blob is never a pre-v0.11.0 envelope, and its history is the old PIN's to recover.
    expect(migrateLegacyMlsStateBlob).not.toHaveBeenCalled();
    expect(ctx.generateDeviceId).not.toHaveBeenCalled();
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
  });

  it('rotates a state ALTERED under the key in hand even under noFreshStart - no PIN opens it (DE7)', async () => {
    const ctx = makeCtx({
      loadStateWithKey: vi.fn().mockRejectedValueOnce(ALTERED).mockResolvedValueOnce(undefined),
    });

    await expect(
      initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' })
    ).resolves.toBeUndefined();

    // Before step 2 this paused for an old PIN that never existed (CORRUPT-2).
    expect(migrateLegacyMlsStateBlob).not.toHaveBeenCalled();
    expect(ctx.generateDeviceId).toHaveBeenCalled();
    expect(localStorage.getItem('mls_device_id_u')).toBe('web-u-fresh');
    expect(ctx.deleteDevice).toHaveBeenCalledWith('u', 'web-u-new', 'retired');
  });
});
