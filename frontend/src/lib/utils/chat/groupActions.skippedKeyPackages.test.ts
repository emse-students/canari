import { describe, expect, it, vi } from 'vitest';
import { resetReportedSkippedRefusals, warnSkippedKeyPackages } from './groupActions';
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
    resetReportedSkippedRefusals();
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

  // A SWEEP RE-DERIVES THE SAME REFUSAL EVERY TIME: said once per device and reason per session,
  // then at `debug`, so the error stays a line a reader does not learn to skip.
  it('reports a trust refusal of one device once per session, and a new device again', () => {
    resetReportedSkippedRefusals();
    const log = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const refused = [{ deviceId: 'phone', reason: 'signature-key-changed' as const }];

    warnSkippedKeyPackages(refused, 'g1', '[SYNC]', log);
    warnSkippedKeyPackages(refused, 'g1', '[SYNC]', log);
    warnSkippedKeyPackages(refused, 'g2', '[SYNC]', log);
    warnSkippedKeyPackages(
      [...refused, { deviceId: 'tablet', reason: 'signature-key-changed' }],
      'g1',
      '[SYNC]',
      log
    );

    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1][1]).toEqual(['tablet']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalled();
    error.mockRestore();
    debug.mockRestore();
  });
});
