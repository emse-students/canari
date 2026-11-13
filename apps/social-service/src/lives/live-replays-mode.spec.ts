import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { LIVE_REPLAYS_MODES, readLiveReplaysMode } from './live-replays-mode';

/** The reader of `platform_config.live_replays_mode`: fail closed to `off`, throw on the unknown. */
describe('readLiveReplaysMode', () => {
  const logger = new Logger('spec');
  const managerAnswering = (rows: unknown[]) =>
    ({ query: jest.fn().mockResolvedValue(rows) }) as unknown as EntityManager;

  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  it.each(LIVE_REPLAYS_MODES)('reads %s as stored', async (mode) => {
    await expect(
      readLiveReplaysMode(managerAnswering([{ live_replays_mode: mode }]), logger)
    ).resolves.toBe(mode);
  });

  it('reads a missing row as off, and says so at ERROR', async () => {
    await expect(readLiveReplaysMode(managerAnswering([]), logger)).resolves.toBe('off');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[LIVE_REPLAY]'));
  });

  it('throws on a value the CHECK forbids, rather than guess', async () => {
    await expect(
      readLiveReplaysMode(managerAnswering([{ live_replays_mode: 'always' }]), logger)
    ).rejects.toThrow(/unknown value/);
  });
});
