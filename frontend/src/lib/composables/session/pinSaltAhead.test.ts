import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  askPinSaltAhead,
  forgetPinSaltAhead,
  resetPinSaltAheadForTests,
  takePinSaltAhead,
} from './pinSaltAhead';

/**
 * The salt asked while the PIN keypad is up: one round trip per keypad, consumed once, a failure
 * that is a VALUE rather than a rejection, and forgotten when the keypad stops being the next thing
 * to submit. What the submit does with it is `pinUnlock.test.ts`.
 */
describe('the PIN salt asked while the keypad is up', () => {
  beforeEach(() => resetPinSaltAheadForTests());

  it('hands the round trip it started to the submit, exactly once', async () => {
    const fetchSalt = vi.fn(async () => 'salt-1');
    expect(askPinSaltAhead('alice', fetchSalt, () => {})).toBe(true);

    const taken = takePinSaltAhead('alice');
    expect(taken).toBeDefined();
    expect(await taken).toEqual({ salt: 'salt-1' });
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
    expect(await takePinSaltAhead('bob')).toEqual({ salt: 'b' });
    expect(await takePinSaltAhead('alice')).toEqual({ salt: 'a' });
  });

  it('evicts a failed round trip and names the failure, so the submit asks the server itself', async () => {
    const log = vi.fn();
    askPinSaltAhead('alice', async () => Promise.reject(new Error('offline')), log);
    // Let the failure reach the eviction handler (a macrotask drains every pending microtask).
    await new Promise((settle) => setTimeout(settle, 0));
    expect(takePinSaltAhead('alice')).toBeUndefined();
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('offline');
  });

  it('hands a submit that took it before it failed a failure VALUE, never the rejection', async () => {
    let fail!: (e: Error) => void;
    askPinSaltAhead(
      'alice',
      () => new Promise<string>((_, reject) => (fail = reject)),
      () => {}
    );
    const taken = takePinSaltAhead('alice');
    fail(new Error('offline'));
    await expect(taken).resolves.toEqual({ failure: 'Error: offline' });
  });

  it('forgets every entry when the keypad ends, and says so once', async () => {
    const log = vi.fn();
    askPinSaltAhead('alice', async () => 's', log);
    forgetPinSaltAhead('signed out', log);
    expect(takePinSaltAhead('alice')).toBeUndefined();
    expect(log).toHaveBeenLastCalledWith('[PIN] Salt asked ahead forgotten: signed out.');

    // Nothing left: silent.
    log.mockClear();
    forgetPinSaltAhead('keypad closed', log);
    expect(log).not.toHaveBeenCalled();
  });

  it('asks nothing without a user id', () => {
    const fetchSalt = vi.fn(async () => 'x');
    expect(askPinSaltAhead('  ', fetchSalt, () => {})).toBe(false);
    expect(fetchSalt).not.toHaveBeenCalled();
  });
});

/**
 * The one decision here that lives in a component: a first setup is never asked ahead, because on a
 * user without a salt `GET pin-salt` WRITES the placeholder row `pin-status` then reads as
 * "registered". A source guard, for the reason `offlineUnlock.test.ts` gives about components.
 */
describe('who is asked ahead', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const service = read('../../components/layout/ChatBackgroundService.svelte');

  it('is a returning user only, at the keypad and on every retry', () => {
    expect(service).toContain('if (!isFirstPinSetup) globalSession.prefetchPinSalt(appendLog);');
    const retry = service.slice(service.indexOf('function askSaltForNextTry'));
    expect(retry.indexOf('if (isFirstPinSetup) return;')).toBeGreaterThan(-1);
    expect(retry.indexOf("if (code === 'device_revoked')")).toBeLessThan(
      retry.indexOf('globalSession.prefetchPinSalt(appendLog);')
    );
  });
});
