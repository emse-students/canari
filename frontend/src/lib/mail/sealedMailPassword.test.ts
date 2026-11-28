// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_KEY, accountLocalStorageKeysIn } from '$lib/utils/accountLocalKeys';
import { moveRememberedMailPassword } from '$lib/utils/chat/pinChange';

const native = vi.hoisted(() => ({ erased: [] as string[] }));
vi.mock('./mailWatchCursor', () => ({
  eraseNativeMailPassword: async (userId: string) => {
    native.erased.push(userId);
  },
}));
import {
  forgetMailPassword,
  readRememberedMailPassword,
  rememberMailPassword,
  resealMailPassword,
} from './sealedMailPassword';

/**
 * D6: the remembered mailbox password is sealed under the device key, never in the clear, follows
 * the key through a change, and is swept with the account.
 */

const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const KEY_C = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const USER = 'user-a';
const REMEMBERED = { account: 'ada@etu.emse.fr', password: 'p4ssw0rd-é' };

beforeEach(() => {
  localStorage.clear();
  native.erased = [];
});

describe('the remembered mailbox password', () => {
  it('is stored sealed, opens under its key only, and is forgotten on demand', async () => {
    expect(await readRememberedMailPassword(USER, KEY_A)).toEqual({ kind: 'none' });
    await rememberMailPassword(USER, KEY_A, REMEMBERED);
    const raw = localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))!;
    expect(raw).not.toContain('p4ssw0rd');
    expect(raw).not.toContain('ada');
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    expect(await readRememberedMailPassword(USER, KEY_A)).toEqual({
      kind: 'opened',
      remembered: REMEMBERED,
    });
    expect(await readRememberedMailPassword(USER, KEY_B)).toEqual({ kind: 'unopenable' });
    forgetMailPassword(USER);
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
  });

  it('forgetting it erases the Android native copy too, even when the page entry is already gone (lot 4b)', async () => {
    await rememberMailPassword(USER, KEY_A, REMEMBERED);
    forgetMailPassword(USER);
    forgetMailPassword(USER);
    expect(native.erased).toEqual([USER, USER]);
  });

  it('an entry this build did not write is unopenable, never parsed as a password', async () => {
    localStorage.setItem(ACCOUNT_KEY.mailSealedPassword(USER), '{"password":"clear"}');
    expect(await readRememberedMailPassword(USER, KEY_A)).toEqual({ kind: 'unopenable' });
  });

  it('a device key change re-seals it, idempotently, and removes one under neither key (I4)', async () => {
    const log: string[] = [];
    await rememberMailPassword(USER, KEY_A, REMEMBERED);
    await resealMailPassword(USER, KEY_A, KEY_B, (m) => log.push(m));
    expect(await readRememberedMailPassword(USER, KEY_B)).toMatchObject({ kind: 'opened' });
    expect(await readRememberedMailPassword(USER, KEY_A)).toEqual({ kind: 'unopenable' });
    // Run again, as a resumed change does: already under the new key, left as it is.
    const before = localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER));
    await resealMailPassword(USER, KEY_A, KEY_B, (m) => log.push(m));
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBe(before);
    // Under neither key: nothing can ever open it again, so it is removed, and said.
    await resealMailPassword(USER, KEY_C, KEY_A, (m) => log.push(m));
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(log.at(-1)).toContain('ERROR');
    // An entry this build did not write is removed too.
    localStorage.setItem(ACCOUNT_KEY.mailSealedPassword(USER), '{"password":"clear"}');
    await resealMailPassword(USER, KEY_A, KEY_B, (m) => log.push(m));
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
  });

  it('is bound to its Canari account: copied under another user, it does not open (M3)', async () => {
    await rememberMailPassword(USER, KEY_A, REMEMBERED);
    const raw = localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))!;
    localStorage.setItem(ACCOUNT_KEY.mailSealedPassword('user-b'), raw);
    expect(await readRememberedMailPassword('user-b', KEY_A)).toEqual({ kind: 'unopenable' });
  });

  it('a write no longer wanted when its seal is done is not made, and says so', async () => {
    expect(await rememberMailPassword(USER, KEY_A, REMEMBERED, localStorage, () => false)).toBe(
      false
    );
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(await rememberMailPassword(USER, KEY_A, REMEMBERED)).toBe(true);
  });

  it("is moved by the PIN change's own step, which never fails the change", async () => {
    await rememberMailPassword(USER, KEY_A, REMEMBERED);
    await moveRememberedMailPassword(USER, KEY_A, KEY_C, () => {});
    expect(await readRememberedMailPassword(USER, KEY_C)).toMatchObject({ kind: 'opened' });
    const log: string[] = [];
    // A storage that throws: logged at ERROR, never thrown into the key change.
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage gone');
    });
    try {
      await expect(
        moveRememberedMailPassword(USER, KEY_C, KEY_A, (m) => log.push(m))
      ).resolves.toBeUndefined();
    } finally {
      read.mockRestore();
    }
    expect(log.at(-1)).toContain('ERROR');
  });

  it('is one of the keys the account deletion sweeps', async () => {
    await rememberMailPassword(USER, KEY_A, REMEMBERED);
    expect(accountLocalStorageKeysIn(localStorage, USER)).toContain(
      ACCOUNT_KEY.mailSealedPassword(USER)
    );
  });
});
