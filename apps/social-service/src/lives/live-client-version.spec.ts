import { HttpStatus } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { LiveEnabledGuard } from './live-enabled.guard';
import { guardContext } from './live-guard-context.test-helper';
import { liveClientVersionAllowed } from './live-client-version';

/** A DataSource whose `platform_config` answers `mode` - the one read the guard makes after the floor. */
function platformDb(mode: string) {
  const query = jest.fn(async () => [{ lives_mode: mode }]);
  return { db: { manager: { query } } as unknown as DataSource, query };
}

async function statusOf(p: () => Promise<unknown>): Promise<number> {
  try {
    await p();
  } catch (e) {
    return (e as { getStatus: () => number }).getStatus();
  }
  return HttpStatus.OK;
}

/**
 * THE PER-CLIENT FLOOR: a build below `1.5.4`, or one naming none, gets the same 404 as a switched-off
 * estate on every lives route (they all sit behind this one guard), and the refusal costs no read.
 */
describe('the live client floor (X-Canari-Client-Version)', () => {
  const saved = process.env.LIVE_ENABLED;
  beforeEach(() => {
    process.env.LIVE_ENABLED = 'true';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_ENABLED;
    else process.env.LIVE_ENABLED = saved;
  });

  it('answers 404 to 1.5.1, to an absent header and to an unreadable one, without reading the database', async () => {
    for (const version of ['1.5.1', '1.5.3', '1.4.9', '0.0.0', null, '', 'latest', '1.5']) {
      const { db, query } = platformDb('on');
      const status = await statusOf(() =>
        new LiveEnabledGuard(db).canActivate(guardContext(version))
      );
      expect(status).toBe(HttpStatus.NOT_FOUND);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('lets 1.5.4, a later build and a 1.5.4 pre-release through', async () => {
    for (const version of ['1.5.4', '1.5.10', '1.6.0', '2.0.0', '1.5.4-alpha.2']) {
      await expect(
        new LiveEnabledGuard(platformDb('on').db).canActivate(guardContext(version))
      ).resolves.toBe(true);
    }
  });

  it('still answers 404 to a current build while lives_mode is off', async () => {
    const status = await statusOf(() =>
      new LiveEnabledGuard(platformDb('off').db).canActivate(guardContext('1.5.4'))
    );
    expect(status).toBe(HttpStatus.NOT_FOUND);
  });

  it('reads the first value of a repeated header', () => {
    expect(liveClientVersionAllowed(['1.5.4', '1.5.1'])).toBe(true);
    expect(liveClientVersionAllowed(['1.5.1'])).toBe(false);
  });
});
