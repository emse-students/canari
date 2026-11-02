/// <reference types="jest" />

import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { readPushMode } from './push-mode';

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
