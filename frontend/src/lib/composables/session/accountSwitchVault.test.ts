// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDeviceKey, saveDeviceKey } from '$lib/utils/deviceKeyVault';
import { VaultOwnerUnprovenError } from '$lib/mls-client';
import { TauriMlsService } from '$lib/services/TauriMlsService';

/**
 * ACCOUNT A LEAVES A VAULT, ACCOUNT B SIGNS IN ON THE SAME PHONE - AND A'S STATE SURVIVES IT.
 *
 * The two halves that decide it, run for real and joined the way the login joins them
 * (`nativeStorageLoginImpl` -> `loginImpl` -> `init`): the vault (`loadDeviceKey`) and the native
 * service's init over `mls.bin`, which is ONE file per install. Only `invoke` is faked, as a
 * `mls.bin` that holds A's state: A's key opens it, and its credential names A.
 *
 * Before 2026-10-14 the vault was one slot naming nobody: B was handed A's key, A's key opened
 * `mls.bin`, the credential said A, and the `mismatch` branch ROTATED the device identity and wrote a
 * fresh state over the file ([auth](../../../../../docs/wiki/frontend/modules/auth.md)).
 */
const ALICE = 'alice-0000';
const BOB = 'bob-11111';
const ALICES_KEY = btoa('A'.repeat(32));
const UNLABELLED = 'canari_device_key_vault';
const WRAP = 'canari_device_key_vault_key';

/** The one slot every build before 2026-10-14 wrote: no account, no additional data. */
async function olderBuildVaults(deviceKeyB64: string): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  sessionStorage.setItem(WRAP, btoa(String.fromCharCode(...raw)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(deviceKeyB64)
    )
  );
  sessionStorage.setItem(
    UNLABELLED,
    `${btoa(String.fromCharCode(...iv))}:${btoa(String.fromCharCode(...cipher))}`
  );
}

/** `mls.bin` holds Alice's state: it opens only under her key, and its credential names her. */
function mlsBinIsAlices(): void {
  invoke.mockImplementation((cmd: string, args?: { deviceKeyB64?: string }) => {
    if (cmd === 'sauvegarder_mls_et_persister') return Promise.resolve([1, 2, 3]);
    if (cmd !== 'initialiser_mls') return Promise.resolve(undefined);
    if (args?.deviceKeyB64 !== ALICES_KEY) return Promise.reject(new Error('STATE_UNDECRYPTABLE'));
    return currentUser === ALICE
      ? Promise.resolve(undefined)
      : Promise.reject(
          new Error(`IDENTITY_MISMATCH: expected ${currentUser} but state contains ${ALICE}`)
        );
  });
}
let currentUser = '';

interface Internals {
  deviceId: string;
  rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string>;
  _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: Record<string, unknown>
  ): Promise<void>;
}

/**
 * What the vault path of the login does with what the vault returns: the same options
 * `loginImpl` passes for a saved state on disk, and the owner flag the vault set.
 */
async function vaultSignIn(
  userId: string
): Promise<{ svc: Internals; outcome: Promise<void> | null }> {
  currentUser = userId;
  const svc = new TauriMlsService() as unknown as Internals;
  svc.deviceId = `${userId}-device`;
  vi.spyOn(svc, 'rotateDeviceIdentity');
  const vaulted = await loadDeviceKey(userId);
  if (!vaulted) return { svc, outcome: null }; // the PIN gate
  const outcome = svc._initImpl(userId, vaulted.deviceKeyB64, undefined, {
    noFreshStart: true,
    stateOnDisk: true,
    vaultOwnerUnproven: !vaulted.ownerProven,
  });
  return { svc, outcome };
}

const writes = () =>
  invoke.mock.calls.filter((c) =>
    ['sauvegarder_mls_et_persister', 'store_push_context'].includes(c[0] as string)
  ).length;

describe('account B signs in where account A left a vault', () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mlsBinIsAlices();
  });

  it("A's LABELLED vault is never offered to B: B goes to the PIN gate, and A still unlocks", async () => {
    await saveDeviceKey(ALICE, ALICES_KEY);

    const bob = await vaultSignIn(BOB);
    expect(bob.outcome, "B was handed a key - A's").toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('initialiser_mls', expect.anything());

    const alice = await vaultSignIn(ALICE);
    await expect(alice.outcome).resolves.toBeUndefined();
    expect(alice.svc.rotateDeviceIdentity).not.toHaveBeenCalled();
  });

  it("an older build's UNLABELLED vault is refused for B on A's mls.bin - no rotation, no write", async () => {
    await olderBuildVaults(ALICES_KEY);

    const bob = await vaultSignIn(BOB);
    await expect(bob.outcome).rejects.toBeInstanceOf(VaultOwnerUnprovenError);
    await expect(bob.outcome).rejects.toMatchObject({ refusal: 'mismatch' });
    expect(bob.svc.rotateDeviceIdentity).not.toHaveBeenCalled();
    expect(writes(), "something wrote over A's mls.bin").toBe(0);
    // And the vault is still there for its owner.
    expect(sessionStorage.getItem(UNLABELLED)).not.toBeNull();
  });

  it('then A signs back in on that same vault, which unlocks and is proven hers', async () => {
    await olderBuildVaults(ALICES_KEY);
    await (await vaultSignIn(BOB)).outcome?.catch(() => {});

    const alice = await vaultSignIn(ALICE);
    await expect(alice.outcome).resolves.toBeUndefined();
    expect(alice.svc.rotateDeviceIdentity).not.toHaveBeenCalled();
  });
});

/**
 * THE WIRING `loginImpl` OWES THE TWO HALVES ABOVE, pinned in the source - the same technique and
 * the same reason as `offlineUnlock.test.ts`: the login is a flow over a dozen module-level
 * dependencies, and what must not drift is which flag reaches which call.
 */
describe('the login carries the vault owner from the vault to the init', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  const auth = read('src/lib/composables/session/sessionAuth.ts');
  const shell = read('src/lib/components/layout/ChatBackgroundService.svelte');
  const login = auth.slice(auth.indexOf('export async function loginImpl('));
  const native = auth.slice(auth.indexOf('export async function nativeStorageLoginImpl('));

  it('reads the vault for the account signing in, on both platforms', () => {
    expect(native.slice(0, 3000)).toContain('await loadDeviceKey(userId);');
    expect(native.slice(0, 3000)).toContain('vaultOwnerUnproven: !vaulted.ownerProven');
    expect(shell).toContain('await loadDeviceKey(savedUser)');
    expect(shell).toContain('{ vaultOwnerUnproven: !vaulted.ownerProven }');
  });

  it('hands the flag to init, refuses before init with no state, and types the refusal', () => {
    expect(login).toContain('          vaultOwnerUnproven,\n');
    expect(login).toContain('if (vaultOwnerUnproven && !mlsStateResult) {');
    expect(login).toContain(
      'if (reason instanceof VaultOwnerUnprovenError) throw vaultRefusedFailure(reason.refusal);'
    );
  });

  it("saves into the account's own slot, and clears only that slot on a failure", () => {
    expect(login).toContain('await saveDeviceKey(owner, deviceKeyB64);');
    expect(login).toContain('clearDeviceKey(ctx.getUserId());');
    expect(login).not.toMatch(/clearDeviceKey\(\);/);
  });

  it('retires the unlabelled vault only AFTER a success, once the key is in its own slot, and only if it is the key', () => {
    // After `setIsLoggedIn(true)`: a login that has not succeeded proves nothing.
    expect(
      login.indexOf('retireUnlabelledDeviceKeyIfOwnedBy(owner, unlockedWith)')
    ).toBeGreaterThan(login.indexOf('ctx.setIsLoggedIn(true);'));
    expect(login).toMatch(
      /if \(deviceKeyB64\) await saveDeviceKey\(owner, deviceKeyB64\);\s+if \(unlockedWith && \(await retireUnlabelledDeviceKeyIfOwnedBy\(owner, unlockedWith\)\)\)/
    );
    // Never a blind delete of the unlabelled slot on the login path.
    expect(
      login.slice(0, login.indexOf('export async function nativeStorageLoginImpl('))
    ).not.toContain('forgetUnlabelledDeviceKey()');
  });

  it('drops a refused key from the session, so nothing later seals with it', () => {
    expect(login).toContain("if (isVaultRefusal(code)) ctx.setDeviceKey('');");
  });

  it('accuses another account ONLY for a proven mismatch on a phone, and stays neutral otherwise', () => {
    const at = auth.indexOf('function vaultRefusedFailure(');
    const body = auth.slice(at, auth.indexOf('\n}\n', at));
    expect(body).toMatch(
      /if \(refusal === 'mismatch' && isTauriRuntime\(\)\) \{\s+return new LoginFailure\('device_holds_other_account', m\.auth_vault_other_account_device\(\)\);/
    );
    expect(body).toContain(
      "return new LoginFailure('vault_not_this_account', m.auth_vault_unverified());"
    );
  });

  it('withholds the reset from a gate whose mls.bin is proven foreign, and locks the act itself too', () => {
    const note = shell.slice(shell.indexOf('function noteOtherAccountState('));
    expect(note.slice(0, 400)).toMatch(
      /if \(provesOtherAccountState\(code\)\) \{\s+deviceHoldsOtherAccount = true;/
    );
    // Both paths that can meet a foreign state read it: the saved unlock (a vault refusal) and every
    // failed unlock (`applyPinFailure` - the keypad, where `mls.owner` proves it since 2026-10-17).
    const failed = shell.slice(shell.indexOf('function onSavedPinFailed('));
    expect(failed.slice(0, 1200)).toMatch(
      /if \(isVaultRefusal\(code\)\) \{\s+noteOtherAccountState\(code\);/
    );
    const applied = shell.slice(shell.indexOf('function applyPinFailure('));
    expect(applied.slice(0, applied.indexOf('\n  }\n'))).toContain('noteOtherAccountState(code);');
    const reset = shell.slice(shell.indexOf('async function handlePinReset('));
    const lock = reset.indexOf('if (deviceHoldsOtherAccount) {');
    expect(lock).toBeGreaterThan(-1);
    // Before the server reset and before the local wipe that deletes mls.bin.
    expect(lock).toBeLessThan(reset.indexOf('/api/mls/security/pin-reset'));
    expect(lock).toBeLessThan(reset.indexOf('resetDeviceAsFresh('));
    expect(reset.slice(lock, reset.indexOf('}', lock) + 1)).toContain('return;');
  });

  it('never leaves the reset withheld from the next account: a session, a sign-out and an expiry clear it', () => {
    // The shell is the root layout and outlives `/login`, so a flag left set would withhold the
    // reset from whoever signs in next on this install - the owner of `mls.bin` included.
    expect(shell).toMatch(
      /\$effect\(\(\) => \{\s+if \(globalSession\.isLoggedIn\) deviceHoldsOtherAccount = false;\s+\}\);/
    );
    for (const head of [
      'async function handlePinSignOut(',
      'async function handleSessionExpired(',
    ]) {
      const fn = shell.slice(shell.indexOf(head));
      const cleared = fn.indexOf('deviceHoldsOtherAccount = false;');
      expect(cleared).toBeGreaterThan(-1);
      // Inside the function, and before its first early return (the expiry's dedup guard).
      const end = fn.indexOf('\n  }\n');
      const ret = fn.indexOf('return;');
      expect(cleared).toBeLessThan(ret > -1 && ret < end ? ret : end);
    }
  });

  it('asks the server whether the refused account has a PIN - its device id was minted by the refusal', () => {
    expect(shell).toContain('{ deviceIdUnproven: true }');
    expect(shell).toContain('opts?.deviceIdUnproven ? null : firstPinSetupFromDevice(');
  });

  it('draws the refused account its own gate rather than a "returning" one', () => {
    const failed = shell.slice(shell.indexOf('function onSavedPinFailed('));
    const branch = failed.indexOf('if (isVaultRefusal(code)) {');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(failed.indexOf('isFirstPinSetup = false;'));
  });
});
