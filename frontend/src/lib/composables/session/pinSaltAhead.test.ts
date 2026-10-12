import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { askPinSaltAhead, resetPinSaltAheadForTests, takePinSaltAhead } from './pinSaltAhead';

/**
 * The salt asked while the PIN keypad is up: one round trip per keypad, consumed once, evicted on
 * failure - and, in `loginImpl`, a device key that is derived early but USED only after the check.
 */
describe('the PIN salt asked while the keypad is up', () => {
  beforeEach(() => resetPinSaltAheadForTests());

  it('hands the round trip it started to the submit, exactly once', async () => {
    const fetchSalt = vi.fn(async () => 'salt-1');
    expect(askPinSaltAhead('alice', fetchSalt, () => {})).toBe(true);

    const taken = takePinSaltAhead('alice');
    expect(taken).toBeDefined();
    expect(await taken).toBe('salt-1');
    // A second submit (after a wrong PIN) gets a round trip of its own, never the consumed one.
    expect(takePinSaltAhead('alice')).toBeUndefined();
    expect(fetchSalt).toHaveBeenCalledTimes(1);
  });

  it('does not start a second round trip while one is in flight', () => {
    const fetchSalt = vi.fn(() => new Promise<string>(() => {}));
    const log = vi.fn();
    askPinSaltAhead('alice', fetchSalt, log);
    expect(askPinSaltAhead('alice', fetchSalt, log)).toBe(false);
    expect(fetchSalt).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith('[PIN] Salt already asked ahead for this keypad.');
  });

  it('keeps each user apart', async () => {
    askPinSaltAhead(
      'alice',
      async () => 'a',
      () => {}
    );
    askPinSaltAhead(
      'bob',
      async () => 'b',
      () => {}
    );
    expect(await takePinSaltAhead('bob')).toBe('b');
    expect(await takePinSaltAhead('alice')).toBe('a');
  });

  it('evicts a failed round trip and names the failure, so the submit asks the server itself', async () => {
    const log = vi.fn();
    askPinSaltAhead('alice', async () => Promise.reject(new Error('offline')), log);
    // Let the rejection reach the eviction handler (a macrotask drains every pending microtask).
    await new Promise((settle) => setTimeout(settle, 0));
    expect(takePinSaltAhead('alice')).toBeUndefined();
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('offline');
  });

  it('asks nothing without a user id', () => {
    const fetchSalt = vi.fn(async () => 'x');
    expect(askPinSaltAhead('  ', fetchSalt, () => {})).toBe(false);
    expect(fetchSalt).not.toHaveBeenCalled();
  });
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * Source guards, for the reason `offlineUnlock.test.ts` gives: `loginImpl` runs over a dozen
 * module-level dependencies, and what must hold here is an ORDER.
 */
describe('loginImpl derives the device key early and uses it only after the PIN check', () => {
  const sessionAuth = read('./sessionAuth.ts');
  const login = sessionAuth.slice(sessionAuth.indexOf('export async function loginImpl'));

  it('installs the device key after the mismatch and the revocation answers, never before', () => {
    const derive = login.indexOf('deriveDeviceKeyB64(ctx.getUserId(), pin, salt)');
    const mismatch = login.indexOf("pinCheckData.status === 'mismatch'");
    const reset = login.indexOf('pinCheckData.resetRequired === true');
    const use = login.indexOf('deviceKeyB64 = await deviceKeyAhead;');
    const install = login.indexOf('ctx.setDeviceKey(deviceKeyB64);');
    for (const at of [derive, mismatch, reset, use, install]) expect(at).toBeGreaterThan(-1);
    expect(derive).toBeLessThan(mismatch);
    expect(mismatch).toBeLessThan(use);
    expect(reset).toBeLessThan(use);
    expect(use).toBeLessThan(install);
  });

  it('starts the device key after the verifier, so the two derivations do not share the worker', () => {
    // Started together, the verifier went from 112 to 215 ms on the Mi 9T and delayed the check.
    const verifier = login.indexOf('computePinVerifier(ctx.getUserId(), ctx.getPin(), salt)');
    const derive = login.indexOf('deriveDeviceKeyB64(ctx.getUserId(), pin, salt)');
    const check = login.indexOf('/api/mls/security/pin-check');
    expect(verifier).toBeGreaterThan(-1);
    expect(verifier).toBeLessThan(derive);
    expect(derive).toBeLessThan(check);
  });

  it('consumes the salt asked ahead before asking the server', () => {
    expect(login).toContain('takePinSaltAhead(ctx.getUserId())');
  });

  it('is asked ahead only for a returning user, since the GET writes on a first setup', () => {
    const service = read('../../components/layout/ChatBackgroundService.svelte');
    expect(service).toContain('if (!isFirstPinSetup) globalSession.prefetchPinSalt(appendLog);');
  });
});
