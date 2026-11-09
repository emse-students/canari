// @vitest-environment happy-dom
/**
 * "HAVE I ANNOUNCED THIS MESSAGE" IS ANSWERED BY ITS ID, AND THE ANSWER OUTLIVES THE PROCESS.
 *
 * A cold start redelivers every row this device never acknowledged, and a push the iOS extension
 * presented acknowledges nothing - so the same message arrives again after the app is relaunched
 * (iPhone 12, `1.5.4-alpha.1`, 2026-11-01). The record is what makes the second arrival silent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFIED_MESSAGES_CAP, recordNotified, unnotifiedOf } from './notifiedMessages';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

describe('the notified-messages record', () => {
  beforeEach(() => localStorage.clear());

  it('answers by message id, and keeps the order of what it was asked', () => {
    recordNotified('u1', ['b']);
    expect(unnotifiedOf('u1', ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('survives the process: it is read from storage, not from memory', () => {
    recordNotified('u1', ['m-1']);
    // What a relaunch sees is the stored value and nothing else.
    expect(JSON.parse(localStorage.getItem(ACCOUNT_KEY.notifiedMessages('u1'))!)).toEqual(['m-1']);
    expect(unnotifiedOf('u1', ['m-1'])).toEqual([]);
  });

  it('is per account', () => {
    recordNotified('u1', ['m-1']);
    expect(unnotifiedOf('u2', ['m-1'])).toEqual(['m-1']);
  });

  it('keeps the most recent ids within its bound', () => {
    const ids = Array.from({ length: NOTIFIED_MESSAGES_CAP + 5 }, (_, i) => `m-${i}`);
    recordNotified('u1', ids);
    expect(unnotifiedOf('u1', ['m-0', `m-${NOTIFIED_MESSAGES_CAP + 4}`])).toEqual(['m-0']);
  });

  it('an unreadable record suppresses nothing rather than everything', () => {
    localStorage.setItem(ACCOUNT_KEY.notifiedMessages('u1'), '{not json');
    expect(unnotifiedOf('u1', ['m-1'])).toEqual(['m-1']);
  });

  it('says ONCE per process that storage refuses, not once per message', async () => {
    // A fresh module: the "already said" flags belong to the process, which a new import models.
    vi.resetModules();
    const fresh = await import('./notifiedMessages');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refuse = () => {
      throw new Error('storage refused');
    };
    vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });
    for (let i = 0; i < 5; i++) {
      expect(fresh.unnotifiedOf('u1', [`m-${i}`])).toEqual([`m-${i}`]);
      fresh.recordNotified('u1', [`m-${i}`]);
    }
    // One line for the unreadable record, one for the unwritable one - not ten.
    expect(warn).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    warn.mockRestore();
  });
});
