/// <reference types="jest" />

import { AppController } from './app.controller';
import { RETENTION_WINDOW_MS } from './retention.constants';

/**
 * `pruneUninvitedEntries` - the 90-day bound of the uninvited-entry count (migration 053).
 *
 * A daily `setInterval` fires for the first time a day after boot, so on a service redeployed more
 * often than daily it never runs: the prune must be in the initial sweep too. And the cutoff is the
 * DATABASE's clock (`now()`), the clock that wrote `firstSeenAt`, never this process's. The SQL is
 * run against a real PostgreSQL by `053_uninvited_entries.integration.spec.ts`.
 */
describe('AppController - pruneUninvitedEntries', () => {
  const prototype = AppController.prototype as unknown as Record<string, () => Promise<void>>;

  const run = async (removed: number) => {
    const query = jest.fn().mockResolvedValue([[], removed]);
    const log = jest.fn();
    await prototype.pruneUninvitedEntries.call({
      queuedMessageRepo: { manager: { query } },
      logger: { log },
    });
    return { query, log };
  };

  it('deletes by the database clock, past the one retention window', async () => {
    const { query } = await run(0);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ')).toMatch(
      /DELETE FROM uninvited_entries WHERE "firstSeenAt" < now\(\) - make_interval\(secs => \$1\)/
    );
    expect(params).toEqual([RETENTION_WINDOW_MS / 1000]);
  });

  it('says how many went, and says nothing when none did', async () => {
    expect((await run(0)).log).not.toHaveBeenCalled();
    expect((await run(3)).log).toHaveBeenCalledWith(
      expect.stringContaining('pruneUninvitedEntries: deleted 3')
    );
  });

  it('is in the initial sweep, so a deployment younger than a day still bounds the table', () => {
    expect(prototype.runInitialSweep.toString()).toContain('pruneUninvitedEntries');
  });
});
