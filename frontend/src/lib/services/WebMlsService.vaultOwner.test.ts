vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn(),
  migrateLegacyMlsStateBlob: vi.fn(),
}));

import { VaultOwnerUnprovenError } from '$lib/mls-client';
import { WebMlsService } from './WebMlsService';

/**
 * THE WEB HALF OF "A VAULT KEY OF UNPROVEN OWNER CHANGES NOTHING".
 *
 * The browser keeps one MLS state per account, so another account's key cannot open this one's -
 * but it can SEAL it: with no saved state, a fresh start wrote account B's first state under the key
 * account A left in the vault, and B's own PIN never opened it again. So with no state the key is
 * refused, and with a state it must open it; no rotation and no fresh start either way.
 */
const UNOPENABLE = new Error('STATE_UNDECRYPTABLE: aead::Error');

function makeCtx(loadStateWithKey: ReturnType<typeof vi.fn>) {
  return {
    userId: '',
    deviceId: 'web-bob',
    delivery: { userId: '', deviceId: '' },
    freshStart: false,
    resolveDeviceId: vi.fn().mockResolvedValue('web-bob'),
    loadStateWithKey,
    classifyStateLoadFailure: WebMlsService.prototype['classifyStateLoadFailure'],
    rotateDeviceIdentity: vi.fn().mockResolvedValue('rotated'),
    // The id is not a returning one here, so a lost-state re-enrolment never applies.
    reenrolLostState: vi.fn().mockResolvedValue(false),
  };
}

const initImpl = (ctx: unknown, state?: Uint8Array, opts?: unknown): Promise<void> =>
  (
    WebMlsService.prototype as unknown as {
      _initImpl(u: string, k: string, s?: Uint8Array, o?: unknown): Promise<void>;
    }
  )._initImpl.call(ctx, 'bob', 'alices-key', state, opts);

describe('WebMlsService._initImpl - a vault key whose owner is not proven', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('refuses with no saved state, and never reaches the fresh start that would seal under it', async () => {
    const ctx = makeCtx(vi.fn().mockResolvedValue(undefined));

    const refused = initImpl(ctx, undefined, { vaultOwnerUnproven: true });

    await expect(refused).rejects.toBeInstanceOf(VaultOwnerUnprovenError);
    await expect(refused).rejects.toMatchObject({ refusal: 'no_state' });
    expect(ctx.loadStateWithKey).not.toHaveBeenCalled();
    // Refused before an id is resolved, so the attempt leaves no "this device existed" behind.
    expect(ctx.resolveDeviceId).not.toHaveBeenCalled();
  });

  it("refuses a saved state the key does not open, instead of offering this account's recovery", async () => {
    const ctx = makeCtx(vi.fn().mockRejectedValue(UNOPENABLE));

    await expect(
      initImpl(ctx, new Uint8Array([1]), { noFreshStart: true, vaultOwnerUnproven: true })
    ).rejects.toMatchObject({ refusal: 'unopenable' });
    expect(ctx.rotateDeviceIdentity).not.toHaveBeenCalled();
  });

  it('CONTROL: without the flag an empty store fresh-starts under whatever key it is given', async () => {
    // What the account B sign-in did before 2026-10-14 - and the proof that the first case is
    // refused by the guard, not by a mock that could never reach the load.
    const ctx = makeCtx(vi.fn().mockResolvedValue(undefined));

    await initImpl(ctx, undefined, {});

    expect(ctx.loadStateWithKey).toHaveBeenCalledWith('alices-key', undefined);
  });
});
