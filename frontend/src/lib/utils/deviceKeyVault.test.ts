// @vitest-environment happy-dom
/**
 * The vault's THREE ways of not returning a key, and why each one owes a different line - and,
 * since 2026-10-14, the account it belongs to.
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
 *
 * THE ACCOUNT: the vault used to be one slot naming nobody, so account B signing in where A had
 * ticked "Rester connecte" was handed A's key ([auth](../../../../docs/wiki/frontend/modules/auth.md)).
 */
import {
  clearDeviceKey,
  clearDeviceKeyAndWrapKey,
  forgetUnlabelledDeviceKey,
  loadDeviceKey,
  retireUnlabelledDeviceKeyIfOwnedBy,
  saveDeviceKey,
  setDeviceKeyPersistence,
} from './deviceKeyVault';
import {
  forgetHardwareHeldKeysForTest,
  noteHardwareHeldDeviceKey,
} from '$lib/crypto/hardwareHeldKey';

const A = 'alice-0000-account';
const B = 'bob-11111-account';
const SLOT_A = `canari_device_key_vault:v2:${A}`;
const SLOT_B = `canari_device_key_vault:v2:${B}`;
const UNLABELLED = 'canari_device_key_vault';
const WRAP = 'canari_device_key_vault_key';

/** The default persistence mode is session-scoped, so that is the store the vault uses. */
const store = () => sessionStorage;

/** Writes a blob the way every build before 2026-10-14 did: one slot, no account, no AAD. */
async function writeUnlabelled(deviceKeyB64: string): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  store().setItem(WRAP, btoa(String.fromCharCode(...raw)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(deviceKeyB64)
    )
  );
  store().setItem(
    UNLABELLED,
    `${btoa(String.fromCharCode(...iv))}:${btoa(String.fromCharCode(...cipher))}`
  );
}

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
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('says nothing when there is simply no vault - absence is not a fault', async () => {
    expect(await loadDeviceKey(A)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('clears a malformed blob and says so, instead of leaving it to fail again on every load', async () => {
    store().setItem(SLOT_A, 'no-separator-here');

    expect(await loadDeviceKey(A)).toBeNull();
    expect(store().getItem(SLOT_A)).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/malformed/i);
  });

  it('names a MISSING WRAP KEY as ordinary, and does not mint one on the way past', async () => {
    store().setItem(SLOT_A, 'aXY=:Y2lwaGVy');

    expect(await loadDeviceKey(A)).toBeNull();
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
    await saveDeviceKey(A, 'ZGV2aWNlLWtleQ==');
    expect(store().getItem(WRAP)).not.toBeNull();
    store().setItem(SLOT_A, 'aXYtMTIzNDU2Nzg5MDEy:dGFtcGVyZWQtY2lwaGVydGV4dA==');

    expect(await loadDeviceKey(A)).toBeNull();
    expect(store().getItem(SLOT_A)).toBeNull();
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toMatch(/did not decrypt under a wrap key that IS present/i);
    expect(said).toMatch(/altered/i);
  });

  it('still round-trips a key it wrote itself, silently, as PROVEN to be that account', async () => {
    await saveDeviceKey(A, 'ZGV2aWNlLWtleQ==');

    expect(await loadDeviceKey(A)).toEqual({ deviceKeyB64: 'ZGV2aWNlLWtleQ==', ownerProven: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never copies a hardware-held key into WebView storage', async () => {
    // A phone's at-rest key lives in the keystore; a vault blob beside its wrap key in the app's
    // files would be a second, software-only copy of it.
    noteHardwareHeldDeviceKey('aGFyZHdhcmUta2V5');
    try {
      await saveDeviceKey(A, 'aGFyZHdhcmUta2V5');
      expect(store().getItem(SLOT_A)).toBeNull();
      expect(store().getItem(WRAP)).toBeNull();
    } finally {
      forgetHardwareHeldKeysForTest();
    }
  });

  it('NEVER hands one account the key another account left, and leaves that key intact', async () => {
    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');

    expect(await loadDeviceKey(B)).toBeNull();
    // A's slot is A's: B's sign-in neither reads nor clears it, so A signing back in still unlocks.
    expect(store().getItem(SLOT_A)).not.toBeNull();
    expect(await loadDeviceKey(A)).toEqual({ deviceKeyB64: 'a2V5LW9mLWFsaWNl', ownerProven: true });
  });

  it('keeps two accounts side by side, and clearing one leaves the other', async () => {
    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');
    await saveDeviceKey(B, 'a2V5LW9mLWJvYg==');

    clearDeviceKey(B);

    expect(await loadDeviceKey(B)).toBeNull();
    expect((await loadDeviceKey(A))?.deviceKeyB64).toBe('a2V5LW9mLWFsaWNl');
  });

  it('refuses a blob MOVED under another account name - the label is bound by the AEAD tag', async () => {
    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');
    store().setItem(SLOT_B, store().getItem(SLOT_A) ?? '');

    expect(await loadDeviceKey(B)).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/account label/i);
    // And the original is untouched.
    expect((await loadDeviceKey(A))?.deviceKeyB64).toBe('a2V5LW9mLWFsaWNl');
  });

  it("offers an older build's UNLABELLED vault as UNPROVEN, to any account, and keeps it", async () => {
    await writeUnlabelled('b2xkLWJ1aWxkLWtleQ==');

    expect(await loadDeviceKey(B)).toEqual({
      deviceKeyB64: 'b2xkLWJ1aWxkLWtleQ==',
      ownerProven: false,
    });
    // Not cleared on B's behalf: it may be A's, and only A's login can prove it.
    expect(store().getItem(UNLABELLED)).not.toBeNull();
    clearDeviceKey(B);
    expect(store().getItem(UNLABELLED)).not.toBeNull();
  });

  it("prefers the account's own slot over the unlabelled one, which it never opens then", async () => {
    await writeUnlabelled('b2xkLWJ1aWxkLWtleQ==');
    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');

    expect(await loadDeviceKey(A)).toEqual({ deviceKeyB64: 'a2V5LW9mLWFsaWNl', ownerProven: true });
  });

  it('forgets the unlabelled vault on request, and a device-wide clear drops every slot', async () => {
    await writeUnlabelled('b2xkLWJ1aWxkLWtleQ==');
    forgetUnlabelledDeviceKey();
    expect(store().getItem(UNLABELLED)).toBeNull();

    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');
    await saveDeviceKey(B, 'a2V5LW9mLWJvYg==');
    clearDeviceKeyAndWrapKey();
    expect(store().getItem(SLOT_A)).toBeNull();
    expect(store().getItem(SLOT_B)).toBeNull();
    expect(store().getItem(WRAP)).toBeNull();
  });
});

describe('setDeviceKeyPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it("keeps every account's slot when a PIN submit restates the mode already set", async () => {
    await setDeviceKeyPersistence(true, null);
    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');

    // B types its PIN on the same install, the "stay signed in" box still ticked.
    await setDeviceKeyPersistence(true, null);

    expect(await loadDeviceKey(A)).toEqual({ deviceKeyB64: 'a2V5LW9mLWFsaWNl', ownerProven: true });
  });

  it('wipes every slot when the mode really changes, and re-saves the signed-in account', async () => {
    await setDeviceKeyPersistence(true, null);
    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');

    await setDeviceKeyPersistence(false, { userId: B, deviceKeyB64: 'a2V5LW9mLWJvYg==' });

    expect(localStorage.getItem(SLOT_A)).toBeNull();
    expect(await loadDeviceKey(B)).toEqual({ deviceKeyB64: 'a2V5LW9mLWJvYg==', ownerProven: true });
  });
});

describe('retireUnlabelledDeviceKeyIfOwnedBy - after a successful login', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('retires the unlabelled slot when it holds the very key this account unlocked with', async () => {
    // A unlocked by its PIN or its own slot: the old copy is A's, and must not stay on offer.
    await writeUnlabelled('a2V5LW9mLWFsaWNl');
    await saveDeviceKey(A, 'a2V5LW9mLWFsaWNl');

    expect(await retireUnlabelledDeviceKeyIfOwnedBy(A, 'a2V5LW9mLWFsaWNl')).toBe(true);
    expect(store().getItem(UNLABELLED)).toBeNull();
    // Its own slot is untouched.
    expect((await loadDeviceKey(A))?.deviceKeyB64).toBe('a2V5LW9mLWFsaWNl');
  });

  it("KEEPS it when it holds another key - it may be another account's, never proven", async () => {
    await writeUnlabelled('a2V5LW9mLWFsaWNl');

    expect(await retireUnlabelledDeviceKeyIfOwnedBy(B, 'a2V5LW9mLWJvYg==')).toBe(false);
    expect(store().getItem(UNLABELLED)).not.toBeNull();
    // And A, signing in later, is still offered it.
    expect(await loadDeviceKey(A)).toEqual({
      deviceKeyB64: 'a2V5LW9mLWFsaWNl',
      ownerProven: false,
    });
  });

  it('does nothing when there is no unlabelled slot', async () => {
    expect(await retireUnlabelledDeviceKeyIfOwnedBy(A, 'a2V5LW9mLWFsaWNl')).toBe(false);
  });
});
