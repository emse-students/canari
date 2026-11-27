// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { eraseMailLocalData, mailLocalKeys } from './mailLocalData';

/** D8: a closed mailbox erases the mail data of THAT Canari account, by an allowlist, and nothing else. */

beforeEach(() => localStorage.clear());

describe('the D8 erasure', () => {
  it('the allowlist is exactly the mail keys of the account', () => {
    expect(mailLocalKeys('u1')).toEqual([
      ACCOUNT_KEY.mailSealedPassword('u1'),
      ACCOUNT_KEY.mailWatchCursor('u1'),
      ACCOUNT_KEY.mailNotifications('u1'),
    ]);
  });

  it("removes the allowlisted keys of that account only, never a neighbour's or another account's", () => {
    localStorage.setItem(ACCOUNT_KEY.mailSealedPassword('u1'), 'sealed');
    localStorage.setItem(ACCOUNT_KEY.mailSealedPassword('u2'), 'other account');
    localStorage.setItem(ACCOUNT_KEY.backupRecoveryCode('u1'), 'backup code');
    localStorage.setItem(ACCOUNT_KEY.deviceId('u1'), 'device');
    localStorage.setItem(`${ACCOUNT_KEY.mailSealedPassword('u1')}:suffix`, 'look-alike');
    localStorage.setItem('canari_mail_anything', 'not listed');

    expect(eraseMailLocalData('u1')).toEqual([ACCOUNT_KEY.mailSealedPassword('u1')]);

    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword('u1'))).toBeNull();
    expect(localStorage.length).toBe(5);
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword('u2'))).toBe('other account');
    expect(localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode('u1'))).toBe('backup code');
  });

  it('erasing twice is a no-op the second time', () => {
    localStorage.setItem(ACCOUNT_KEY.mailSealedPassword('u1'), 'sealed');
    eraseMailLocalData('u1');
    expect(eraseMailLocalData('u1')).toEqual([]);
  });
});
