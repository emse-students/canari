/**
 * THE EARLY HARDWARE-HELD KEY READ INSTALLS ONLY FOR THE ATTEMPT THAT IS STILL LIVE (review of
 * #3335). The read is not awaited in line, so it can resolve after its login failed: the key must
 * then stay out of memory, decided by the attempt's own state, never by timing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginLoginAttempt, endLoginAttempt, installEarlyKeyIfLive } from './earlyKeyRead';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('installEarlyKeyIfLive', () => {
  it('a login that fails before the read resolves leaves no key in memory', async () => {
    let keyInMemory: string | null = null;
    const log = vi.fn();
    const read = deferred<string | null>();
    const attempt = beginLoginAttempt(7);

    const bound = installEarlyKeyIfLive(
      read.promise,
      attempt,
      () => true,
      (key) => (keyInMemory = key),
      log
    );
    // The login fails (session expired, identity split, ...) while the keystore is still reading.
    endLoginAttempt(attempt);
    read.resolve('k'.repeat(44));

    expect(await bound).toBe(false);
    expect(keyInMemory).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('login attempt 7 ended'));
  });

  it('installs while the attempt is live', async () => {
    let keyInMemory: string | null = null;
    const attempt = beginLoginAttempt(8);
    const installed = await installEarlyKeyIfLive(
      Promise.resolve('key'),
      attempt,
      () => true,
      (key) => (keyInMemory = key),
      vi.fn()
    );
    expect(installed).toBe(true);
    expect(keyInMemory).toBe('key');
  });

  it('drops the key after a sign-out, and installs nothing for a failed read', async () => {
    const install = vi.fn();
    const log = vi.fn();
    expect(
      await installEarlyKeyIfLive(
        Promise.resolve('key'),
        beginLoginAttempt(9),
        () => false,
        install,
        log
      )
    ).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('signed out'));
    expect(
      await installEarlyKeyIfLive(
        Promise.resolve(null),
        beginLoginAttempt(10),
        () => true,
        install,
        log
      )
    ).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it('loginImpl ends its attempt FIRST in its finally, and installs through the bound read', () => {
    const auth = readFileSync(
      join(process.cwd(), 'src/lib/composables/session/sessionAuth.ts'),
      'utf8'
    );
    const login = auth.slice(auth.indexOf('export async function loginImpl('));
    expect(login).toContain('const attempt = beginLoginAttempt(loginId);');
    expect(login).toContain('earlyHardwareKey = installEarlyKeyIfLive(');
    const fin = login.slice(login.indexOf('  } finally {\n    // FIRST'));
    expect(fin.indexOf('endLoginAttempt(attempt);')).toBeGreaterThan(-1);
    expect(fin.indexOf('endLoginAttempt(attempt);')).toBeLessThan(
      fin.indexOf('releaseLoginFlag();')
    );
  });
});
