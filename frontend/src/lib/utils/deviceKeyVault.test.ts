/**
 * The vault's THREE ways of not returning a key, and why each one owes a different line.
 *
 * `loadDeviceKey` had two silent branches. A blob with no `iv:` separator returned null without
 * clearing anything - so the unusable blob stayed and failed identically on every later load, for
 * ever, having said nothing once - and every other failure went through one `catch` whose comment
 * named two causes (`tampered blob, key rotated`) and separated neither.
 *
 * Separating them is not tidiness. One of the two is ORDINARY - a storage clear, a switch between
 * session- and local-scoped persistence, a new browser profile - and the other means the ciphertext
 * or its key was ALTERED after it was written, which is the only security signal this file can
 * emit. They were being reported by the same silence.
 *
 * The discriminator is whether a wrap key was stored at all, and it has to be read BEFORE anything
 * mints one: `getOrCreateWrapKey` writes a fresh key when none is present, so calling it here both
 * wrote on a read path and destroyed the evidence.
 */
import { loadDeviceKey, saveDeviceKey } from './deviceKeyVault';

const BLOB = 'canari_device_key_vault';
const WRAP = 'canari_device_key_vault_key';

/** The default persistence mode is session-scoped, so that is the store the vault uses. */
const store = () => sessionStorage;

describe('loadDeviceKey', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Restore first: spying on an already-spied `console.warn` STACKS, so without this the calls of
    // one case are still on the spy the next case asserts against - and "said nothing" then fails
    // for a line the previous test caused.
    vi.restoreAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('says nothing when there is simply no vault - absence is not a fault', async () => {
    expect(await loadDeviceKey()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('clears a malformed blob and says so, instead of leaving it to fail again on every load', async () => {
    store().setItem(BLOB, 'no-separator-here');

    expect(await loadDeviceKey()).toBeNull();
    expect(store().getItem(BLOB)).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/malformed/i);
  });

  it('names a MISSING WRAP KEY as ordinary, and does not mint one on the way past', async () => {
    store().setItem(BLOB, 'aXY=:Y2lwaGVy');

    expect(await loadDeviceKey()).toBeNull();
    // THE POINT OF THE WHOLE CHANGE: a read that mints a wrap key leaves the next reader unable to
    // tell this case from tampering, because the key it finds is one this call wrote.
    expect(store().getItem(WRAP)).toBeNull();
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toMatch(/wrap key is gone/i);
    expect(said).toMatch(/NOT evidence of tampering/i);
  });

  it('ACCUSES when the wrap key is present and the blob still will not open', async () => {
    // A real wrap key, and a ciphertext that was never encrypted under it: everything ordinary is
    // excluded, so what is left is alteration.
    await saveDeviceKey('ZGV2aWNlLWtleQ==');
    expect(store().getItem(WRAP)).not.toBeNull();
    store().setItem(BLOB, 'aXYtMTIzNDU2Nzg5MDEy:dGFtcGVyZWQtY2lwaGVydGV4dA==');

    expect(await loadDeviceKey()).toBeNull();
    expect(store().getItem(BLOB)).toBeNull();
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toMatch(/did not decrypt under a wrap key that IS present/i);
    expect(said).toMatch(/altered/i);
  });

  it('still round-trips a key it wrote itself, silently', async () => {
    await saveDeviceKey('ZGV2aWNlLWtleQ==');

    expect(await loadDeviceKey()).toBe('ZGV2aWNlLWtleQ==');
    expect(warn).not.toHaveBeenCalled();
  });
});
