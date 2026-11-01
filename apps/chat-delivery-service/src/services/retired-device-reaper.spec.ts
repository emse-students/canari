/// <reference types="jest" />

import {
  RETIRED_DEVICE_PREDICATE_SQL,
  readRetiredDeviceReaperMode,
  runRetiredDeviceReaper,
  type RetiredDeviceCandidate,
} from './retired-device-reaper';
import { RETIRED_DEVICE_REAP_CAP } from '../retention.constants';

/**
 * THE REAPER'S CONTROL FLOW, with the database stubbed: the switch, the dry run that writes
 * nothing, the cap handed to the statement, the re-check before each revocation, the per-device
 * isolation and the level of the summary line. What the PREDICATE selects is judged against a real
 * PostgreSQL in `retired-device-reaper.integration.spec.ts` - a stub cannot judge SQL.
 */
describe('retired-device reaper', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const candidate = (deviceId: string): RetiredDeviceCandidate & { matched: number } => ({
    userId: `u-${deviceId}`,
    deviceId,
    oldestQueuedAt: new Date('2026-09-01T00:00:00Z'),
    queuedRows: 12,
    matched: 3,
  });

  const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });
  const messaging = () => ({
    purgeDeviceFootprint: jest.fn().mockResolvedValue({
      groupsCleaned: 2,
      keyPackagesDeleted: 1,
      oneTimeKeyPackagesDeleted: 3,
      queuedMessagesDeleted: 12,
      keyGroupsRecorded: 1,
    }),
    notifyDeviceRevoked: jest.fn().mockResolvedValue(false),
  });

  /**
   * A database answering the selection with `selected`, each re-check with the one device it names
   * (unless listed in `gone`), and the ban upsert with `retired`.
   */
  const database = (selected: ReturnType<typeof candidate>[], gone: string[] = []) => ({
    // `never`: the stub stands in for TypeORM's generic `query<T>`, whose caller names the row type.
    query: jest.fn(async (sql: string, params: unknown[]): Promise<never> => {
      if (sql === RETIRED_DEVICE_PREDICATE_SQL) {
        const only = params[5] as string | null;
        if (only === null) return selected as never;
        return (gone.includes(only) ? [] : selected.filter((c) => c.deviceId === only)) as never;
      }
      if (sql.includes('INSERT INTO revoked_device')) return [{ reason: 'retired' }] as never;
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
    }),
  });

  describe('the switch', () => {
    it.each([
      [undefined, 'off'],
      ['', 'off'],
      ['off', 'off'],
      [' dry-run ', 'dry-run'],
      ['on', 'on'],
    ])('reads %p as %s', (raw, mode) => {
      expect(readRetiredDeviceReaperMode(raw, logger())).toBe(mode);
    });

    it.each(['true', 'ON', 'dryrun', '1'])('refuses %p, so the service does not boot', (raw) => {
      expect(() => readRetiredDeviceReaperMode(raw, logger())).toThrow(/RETIRED_DEVICE_REAPER/);
    });

    it('OFF does nothing: not one query, not one revocation, not one line', async () => {
      const db = database([candidate('web-a')]);
      const m = messaging();
      const l = logger();
      const run = await runRetiredDeviceReaper({ mode: 'off', db, messaging: m, logger: l });
      expect(db.query).not.toHaveBeenCalled();
      expect(m.purgeDeviceFootprint).not.toHaveBeenCalled();
      expect(m.notifyDeviceRevoked).not.toHaveBeenCalled();
      expect(l.log).not.toHaveBeenCalled();
      expect(run).toMatchObject({ mode: 'off', matched: 0, revoked: 0 });
    });
  });

  it('a DRY RUN lists and counts, and writes nothing', async () => {
    const db = database([candidate('web-a'), candidate('web-b')]);
    const m = messaging();
    const l = logger();
    const run = await runRetiredDeviceReaper({
      mode: 'dry-run',
      db,
      messaging: m,
      logger: l,
      now: () => NOW,
    });
    // ONE statement, the selection; no re-check, no ban, no purge, no signal.
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toBe(RETIRED_DEVICE_PREDICATE_SQL);
    expect(m.purgeDeviceFootprint).not.toHaveBeenCalled();
    expect(m.notifyDeviceRevoked).not.toHaveBeenCalled();
    expect(run).toMatchObject({ mode: 'dry-run', matched: 3, revoked: 0 });
    const lines = l.log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((x) => x.includes('would revoke'))).toHaveLength(2);
    expect(lines[lines.length - 1]).toMatch(/mode=dry-run matched=3 listed=2 .* nothing written/);
  });

  it('hands the cap to the statement, and the default cap is the constant', async () => {
    const db = database([]);
    await runRetiredDeviceReaper({ mode: 'dry-run', db, messaging: messaging(), logger: logger() });
    await runRetiredDeviceReaper({
      mode: 'dry-run',
      db,
      messaging: messaging(),
      logger: logger(),
      cap: 7,
    });
    expect(db.query.mock.calls[0][1][3]).toBe(RETIRED_DEVICE_REAP_CAP);
    expect(db.query.mock.calls[1][1][3]).toBe(7);
  });

  it('a dry run naming more than one cap ACCUSES', async () => {
    const l = logger();
    await runRetiredDeviceReaper({
      mode: 'dry-run',
      db: database([candidate('web-a')]),
      messaging: messaging(),
      logger: l,
      cap: 1,
    });
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/matched=3 listed=1 cap=1/));
  });

  it('ON revokes each candidate as `retired`, after re-checking it, and the summary ACCUSES', async () => {
    const db = database([candidate('web-a'), candidate('web-b')]);
    const m = messaging();
    const l = logger();
    const run = await runRetiredDeviceReaper({
      mode: 'on',
      db,
      messaging: m,
      logger: l,
      now: () => NOW,
    });
    expect(run).toMatchObject({ revoked: 2, skipped: 0, failed: 0, queuedMessagesDeleted: 24 });
    // Selection, then per device: re-check, ban.
    const sqls = db.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.filter((s) => s === RETIRED_DEVICE_PREDICATE_SQL)).toHaveLength(3);
    const bans = db.query.mock.calls.filter((c) => String(c[0]).includes('revoked_device ('));
    expect(bans.map((c) => (c[1] as unknown[])[4])).toEqual(['retired', 'retired']);
    expect(m.purgeDeviceFootprint).toHaveBeenCalledWith('u-web-a', 'web-a', {
      recordKeyGroupsHeld: true,
    });
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/mode=on matched=3 .* revoked=2/));
  });

  it('a device that no longer matches at the re-check is kept', async () => {
    const db = database([candidate('web-a'), candidate('web-b')], ['web-a']);
    const m = messaging();
    const run = await runRetiredDeviceReaper({ mode: 'on', db, messaging: m, logger: logger() });
    expect(run).toMatchObject({ revoked: 1, skipped: 1 });
    expect(m.purgeDeviceFootprint).toHaveBeenCalledTimes(1);
    expect(m.purgeDeviceFootprint).toHaveBeenCalledWith('u-web-b', 'web-b', expect.anything());
  });

  it('one failing device is logged at ERROR and the others are still revoked', async () => {
    const db = database([candidate('web-a'), candidate('web-b'), candidate('web-c')]);
    const m = messaging();
    m.purgeDeviceFootprint.mockRejectedValueOnce(new Error('connection reset'));
    const l = logger();
    const run = await runRetiredDeviceReaper({ mode: 'on', db, messaging: m, logger: l });
    expect(run).toMatchObject({ revoked: 2, failed: 1 });
    expect(l.error).toHaveBeenCalledWith(
      expect.stringMatching(/FAILED to revoke user=u-web-a device=web-a: connection reset/)
    );
    // The summary of a run with a failure is an ERROR, not a warning.
    expect(l.error).toHaveBeenLastCalledWith(expect.stringMatching(/revoked=2 skipped=0 failed=1/));
  });

  it('a run that matches nothing says so quietly', async () => {
    const l = logger();
    const run = await runRetiredDeviceReaper({
      mode: 'on',
      db: database([]),
      messaging: messaging(),
      logger: l,
    });
    expect(run).toMatchObject({ matched: 0, revoked: 0 });
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.error).not.toHaveBeenCalled();
    expect(l.log).toHaveBeenCalledWith(expect.stringMatching(/mode=on matched=0 .* revoked=0/));
  });
});
