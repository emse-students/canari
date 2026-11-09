/// <reference types="jest" />

import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ENVELOPE_WAKE_VERSION,
  effectiveWakeVersion,
  parseWakeVersion,
  readPushMode,
} from './push-mode';

/**
 * The switch of the content-free wake-up push, read straight from `platform_config`
 * (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
 */
describe('readPushMode', () => {
  const managerAnswering = (rows: unknown[]) =>
    ({ query: jest.fn().mockResolvedValue(rows) }) as unknown as EntityManager;
  const logger = () => ({ error: jest.fn() }) as unknown as Logger & { error: jest.Mock };

  it('answers the value the row holds', async () => {
    const log = logger();
    await expect(readPushMode(managerAnswering([{ push_mode: 'wake' }]), log)).resolves.toBe(
      'wake'
    );
    await expect(readPushMode(managerAnswering([{ push_mode: 'full' }]), log)).resolves.toBe(
      'full'
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('reads a missing row as the value it is created with, and accuses it once per process', async () => {
    const log = logger();
    await expect(readPushMode(managerAnswering([]), log)).resolves.toBe('full');
    await expect(readPushMode(managerAnswering([]), log)).resolves.toBe('full');
    await expect(readPushMode(managerAnswering([]), log)).resolves.toBe('full');
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('[PUSH_MODE]'));
  });

  it('throws on a value outside the two, every time', async () => {
    const log = logger();
    await expect(readPushMode(managerAnswering([{ push_mode: 'maybe' }]), log)).rejects.toThrow(
      /unknown value/
    );
    await expect(readPushMode(managerAnswering([{ push_mode: null }]), log)).rejects.toThrow(
      /unknown value/
    );
  });
});

/** The capability a registration declares (`push_token.wakeVersion`, migration 046). */
describe('parseWakeVersion', () => {
  it('reads a declared version as it is', () => {
    expect(parseWakeVersion({ wakeVersion: 0 })).toEqual({ version: 0, malformed: false });
    expect(parseWakeVersion({ wakeVersion: 2 })).toEqual({ version: 2, malformed: false });
  });

  it('stores a newer binary at the highest version this server serves - versions are cumulative', () => {
    expect(parseWakeVersion({ wakeVersion: 9 })).toEqual({
      version: ENVELOPE_WAKE_VERSION,
      malformed: false,
    });
  });

  it('reads the step-1 declaration `wake: true` as version 1, and silence as 0', () => {
    expect(parseWakeVersion({ wake: true })).toEqual({ version: 1, malformed: false });
    expect(parseWakeVersion({ wake: 'yes' })).toEqual({ version: 0, malformed: false });
    expect(parseWakeVersion({})).toEqual({ version: 0, malformed: false });
  });

  it('reads an unreadable version as 0 and says so, whatever `wake` says', () => {
    for (const wakeVersion of ['2', 1.5, -1, null]) {
      expect(parseWakeVersion({ wake: true, wakeVersion })).toEqual({
        version: 0,
        malformed: true,
      });
    }
  });
});

/** Until `wakeCapable` is dropped, a row a pre-046 server re-registered must not be woken. */
describe('effectiveWakeVersion', () => {
  it('reads the version while wakeCapable agrees', () => {
    expect(effectiveWakeVersion({ wakeVersion: 2, wakeCapable: true })).toBe(2);
    expect(effectiveWakeVersion({ wakeVersion: 1, wakeCapable: true })).toBe(1);
  });

  it('reads 0 when a server that knows only wakeCapable wrote it false', () => {
    expect(effectiveWakeVersion({ wakeVersion: 2, wakeCapable: false })).toBe(0);
    expect(effectiveWakeVersion({ wakeVersion: 1, wakeCapable: false })).toBe(0);
  });
});
