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

  // A REFUSED IDENTITY OR KEY IS NOT A STALE PACKAGE, so the remedy for one ("republish") would
  // send a reader to the wrong device. It is an error, with its own words.
  it('reports a trust refusal as an error and never as a package to republish', () => {
    const log = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSkippedKeyPackages(
      [
        { deviceId: 'phone', reason: 'signature-key-changed' },
        { deviceId: 'web', reason: 'identity-mismatch' },
      ],
      'g1',
      '[ADD]',
      log
    );
    expect(log).toHaveBeenCalledTimes(2);
    for (const [line] of log.mock.calls) {
      expect(line).toContain('REFUSED');
      expect(line).not.toContain('republish');
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
