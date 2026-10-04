import { describe, expect, it, vi } from 'vitest';
import { warnSkippedKeyPackages } from './groupActions';
import { groupSkippedByReason } from '$lib/mls-client/skippedKeyPackage';

describe('groupSkippedByReason', () => {
  it('groups device ids by reason in first-seen order', () => {
    expect(
      groupSkippedByReason([
        { deviceId: 'a', reason: 'expired' },
        { deviceId: 'b', reason: 'invalid-signature' },
        { deviceId: 'c', reason: 'expired' },
      ])
    ).toEqual([
      { reason: 'expired', deviceIds: ['a', 'c'] },
      { reason: 'invalid-signature', deviceIds: ['b'] },
    ]);
  });
});

describe('warnSkippedKeyPackages', () => {
  it('stays silent when nothing was skipped', () => {
    const log = vi.fn();
    warnSkippedKeyPackages([], 'g1', '[ADD]', log);
    expect(log).not.toHaveBeenCalled();
  });

  it('prints one line per reason, naming the reason and its devices', () => {
    const log = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnSkippedKeyPackages(
      [
        { deviceId: 'phone', reason: 'expired' },
        { deviceId: 'web', reason: 'undecodable' },
        { deviceId: 'tablet', reason: 'expired' },
      ],
      'g1',
      '[ADD]',
      log
    );
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('KeyPackage expired');
    expect(log.mock.calls[0][0]).toContain('phone, tablet');
    expect(log.mock.calls[1][0]).toContain('KeyPackage undecodable');
    expect(log.mock.calls[1][0]).toContain('web');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
