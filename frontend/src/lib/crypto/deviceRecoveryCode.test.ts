// @vitest-environment happy-dom
import { ACCOUNT_KEY, accountLocalStorageKeysIn } from '$lib/utils/accountLocalKeys';
import {
  backupOwedAfterKeyMove,
  clearBackupOwedAfterKeyMove,
  deviceRecoveryCode,
  keepDeviceRecoveryCode,
  noteBackupOwedAfterKeyMove,
  resealDeviceRecoveryCode,
} from './deviceRecoveryCode';
import { gateStorage, holdStorageForKeyChange } from '$lib/db/deviceKeyGate';
import type { IStorage } from '$lib/db/types';

/**
 * ONE BACKUP CODE PER DEVICE (decision of 2026-10-22). What these hold: the second export reuses the
 * first one's code; a code is kept only once a file was saved with it; it is never stored in the
 * clear; it follows the device key through a key change; and a code the key no longer opens is
 * replaced, SAID to be.
 */

const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const USER = 'user-a';
const log = () => {};

beforeEach(() => localStorage.clear());

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('deviceRecoveryCode', () => {
  it('generates a first code, and keeps it only once the file was saved', async () => {
    const first = await deviceRecoveryCode(USER, KEY_A, log);
    expect(first.origin).toBe('new');
    // A cancelled save: nothing kept, so the next export is new again, never a code nobody saw.
    expect(localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode(USER))).toBeNull();
    expect((await deviceRecoveryCode(USER, KEY_A, log)).origin).toBe('new');

    await first.keep(KEY_A);
    const second = await deviceRecoveryCode(USER, KEY_A, log);
    expect(second.origin).toBe('kept');
    expect(hex(second.bytes)).toBe(hex(first.bytes));
  });

  it('never stores the code in the clear', async () => {
    const code = await deviceRecoveryCode(USER, KEY_A, log);
    await code.keep(KEY_A);
    const stored = localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode(USER))!;
    expect(stored).not.toContain(hex(code.bytes));
    expect(stored).not.toContain(btoa(String.fromCharCode(...code.bytes)));
  });

  it('replaces, and says so, a code the device key does not open', async () => {
    const first = await deviceRecoveryCode(USER, KEY_A, log);
    await first.keep(KEY_A);
    const after = await deviceRecoveryCode(USER, KEY_B, log);
    expect(after.origin).toBe('replaced');
    expect(hex(after.bytes)).not.toBe(hex(first.bytes));
  });

  it('seals a code under the key held when the save returns, so a key change during the export does not replace it', async () => {
    // The export started under KEY_A; the move to the hardware-held key ran during the save and
    // re-sealed every store (there was no code yet). The code is kept under the session's key NOW.
    const started = await deviceRecoveryCode(USER, KEY_A, log);
    expect(started.origin).toBe('new');
    await started.keep(KEY_B);
    const next = await deviceRecoveryCode(USER, KEY_B, log);
    expect(next.origin).toBe('kept');
    expect(hex(next.bytes)).toBe(hex(started.bytes));
  });

  it('a keep that waits on a key change in progress writes under the key the change moved to', async () => {
    // The session adopts the new key only once the storage gate is released, so its copy lags the
    // stores for a moment; the keep runs INSIDE the gate and asks the gate which key is live.
    const keyC = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
    const keyD = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));
    const store = gateStorage({ ping: async () => {} } as unknown as IStorage, USER);
    const code = await deviceRecoveryCode(USER, keyC, log);
    let finishReseal!: () => void;
    const resealing = new Promise<void>((resolve) => (finishReseal = resolve));
    const change = holdStorageForKeyChange(store, keyC, keyD, async () => {
      await resealing;
      await resealDeviceRecoveryCode(USER, keyC, keyD, log);
    });
    const kept = keepDeviceRecoveryCode(USER, code, keyC);
    finishReseal();
    await Promise.all([change, kept]);

    const next = await deviceRecoveryCode(USER, keyD, log);
    expect(next.origin).toBe('kept');
    expect(hex(next.bytes)).toBe(hex(code.bytes));
  });

  it('replaces an entry this build did not write', async () => {
    localStorage.setItem(ACCOUNT_KEY.backupRecoveryCode(USER), 'not json');
    expect((await deviceRecoveryCode(USER, KEY_A, log)).origin).toBe('replaced');
  });
});

describe('resealDeviceRecoveryCode', () => {
  it('moves the code to the new device key, so the same code survives a key change', async () => {
    const first = await deviceRecoveryCode(USER, KEY_A, log);
    await first.keep(KEY_A);
    await resealDeviceRecoveryCode(USER, KEY_A, KEY_B, log);
    const after = await deviceRecoveryCode(USER, KEY_B, log);
    expect(after.origin).toBe('kept');
    expect(hex(after.bytes)).toBe(hex(first.bytes));
  });

  it('is idempotent, as a resumed key change needs it to be', async () => {
    const first = await deviceRecoveryCode(USER, KEY_A, log);
    await first.keep(KEY_A);
    await resealDeviceRecoveryCode(USER, KEY_A, KEY_B, log);
    const once = localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode(USER));
    await resealDeviceRecoveryCode(USER, KEY_A, KEY_B, log);
    expect(localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode(USER))).toBe(once);
  });

  it('does nothing on a device that never exported', async () => {
    await resealDeviceRecoveryCode(USER, KEY_A, KEY_B, log);
    expect(localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode(USER))).toBeNull();
  });
});

describe('the backup owed after the move to the hardware-held key', () => {
  it('is noted, read and cleared per account', () => {
    expect(backupOwedAfterKeyMove(USER)).toBe(false);
    noteBackupOwedAfterKeyMove(USER);
    expect(backupOwedAfterKeyMove(USER)).toBe(true);
    expect(backupOwedAfterKeyMove('user-b')).toBe(false);
    clearBackupOwedAfterKeyMove(USER);
    expect(backupOwedAfterKeyMove(USER)).toBe(false);
  });
});

it("goes with the account's other keys when the account is deleted", async () => {
  const code = await deviceRecoveryCode(USER, KEY_A, log);
  await code.keep(KEY_A);
  noteBackupOwedAfterKeyMove(USER);
  const swept = accountLocalStorageKeysIn(localStorage, USER);
  expect(swept).toContain(ACCOUNT_KEY.backupRecoveryCode(USER));
  expect(swept).toContain(ACCOUNT_KEY.backupOwedAfterKeyMove(USER));
});
