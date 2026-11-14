import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RETENTION_COLUMNS, readRetentionDays } from './retention-settings';

/** The reader of core's retention durations (migration 025): read, defaulted only on a missing row. */
describe('readRetentionDays', () => {
  const logger = () =>
    ({ error: jest.fn(), debug: jest.fn(), warn: jest.fn() }) as unknown as Logger & {
      error: jest.Mock;
    };
  const managerAnswering = (rows: Record<string, unknown>[] | Error) =>
    ({
      query: jest.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))),
    }) as unknown as EntityManager;
  const ROW = {
    retention_reel_days: 180,
    retention_live_replay_days: 7,
    retention_chat_reel_days: 14,
    retention_idle_media_days: 60,
  };

  it('reads the four columns as the row holds them', async () => {
    await expect(readRetentionDays(managerAnswering([ROW]), logger())).resolves.toEqual({
      reelDays: 180,
      liveReplayDays: 7,
      chatReelDays: 14,
      idleMediaDays: 60,
    });
  });

  it("reads a missing row as the columns' defaults, and accuses it ONCE per process", async () => {
    const log = logger();
    const days = await readRetentionDays(managerAnswering([]), log);
    expect(days).toEqual(Object.fromEntries(RETENTION_COLUMNS.map((c) => [c.key, c.defaultDays])));
    await readRetentionDays(managerAnswering([]), log);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it.each([null, 0, -1, 1.5, '30'])(
    'THROWS on an unusable value %p, never guessing',
    async (bad) => {
      await expect(
        readRetentionDays(managerAnswering([{ ...ROW, retention_chat_reel_days: bad }]), logger())
      ).rejects.toThrow(/retention_chat_reel_days/);
    }
  );

  it('THROWS when the query fails', async () => {
    await expect(
      readRetentionDays(managerAnswering(new Error('connection reset')), logger())
    ).rejects.toThrow('connection reset');
  });
});
