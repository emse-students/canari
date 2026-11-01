/// <reference types="jest" />

import {
  OWNER_UNBOUND_SESSION_SQL,
  RETIRED_BUDGET_SPENT_SQL,
  RETIRED_DEVICE_PREDICATE_SQL,
  readRetiredDeviceReaperMode,
  runRetiredDeviceReaper,
  type RetiredDeviceCandidate,
} from './retired-device-reaper';
import { RETIRED_DEVICE_DAILY_BUDGET } from '../retention.constants';

/**
 * THE REAPER'S CONTROL FLOW, with the database stubbed: the switch, the dry run that writes
 * nothing, the daily budget read from the ban rows, the re-checks before each revocation, the
 * per-device isolation and the level of the summary line. What the PREDICATE selects, and that the
 * budget is durable, is judged against a real PostgreSQL in
 * `retired-device-reaper.integration.spec.ts` - a stub cannot judge SQL.
 */
describe('retired-device reaper', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const candidate = (deviceId: string): RetiredDeviceCandidate & { matched: number } => ({
    userId: `u-${deviceId}`,
    deviceId,
    oldestQueuedAt: new Date('2026-07-01T00:00:00Z'),
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
   * A database answering the selection with `selected`; each re-check with the one device it names
   * unless it is in `gone`; the owner-session check with a row for the owners in `signedIn`; the
   * budget with `spent` plus every ban written so far; and the ban upsert with `retired`.
   */
  const database = (
    selected: ReturnType<typeof candidate>[],
    opts: { gone?: string[]; signedIn?: string[]; spent?: number } = {}
  ) => {
    let bans = 0;
    return {
      // `never`: the stub stands in for TypeORM's generic `query<T>`, whose caller names the row type.
      query: jest.fn(async (sql: string, params: unknown[]): Promise<never> => {
        if (sql === RETIRED_BUDGET_SPENT_SQL) return [{ spent: (opts.spent ?? 0) + bans }] as never;
        if (sql === RETIRED_DEVICE_PREDICATE_SQL) {
          const only = params[5] as string | null;
          if (only === null) return selected.slice(0, params[3] as number) as never;
          const gone = opts.gone ?? [];
          return (gone.includes(only) ? [] : selected.filter((c) => c.deviceId === only)) as never;
        }
        if (sql === OWNER_UNBOUND_SESSION_SQL) {
          return ((opts.signedIn ?? []).includes(params[0] as string) ? [{}] : []) as never;
        }
        if (sql.includes('INSERT INTO revoked_device')) {
          bans += 1;
          return [{ reason: 'retired' }] as never;
        }
        throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
      }),
    };
  };
  const sqls = (db: ReturnType<typeof database>) => db.query.mock.calls.map((c) => c[0] as string);

  describe('the switch', () => {
    it.each([
      [undefined, 'off'],
      ['', 'off'],
      ['off', 'off'],
      [' dry-run ', 'dry-run'],
      ['on', 'on'],
    ])('reads %p as %s, in ONE boot line', (raw, mode) => {
      const l = logger();
      expect(readRetiredDeviceReaperMode(raw, l)).toBe(mode);
      expect(l.log).toHaveBeenCalledTimes(1);
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
      expect(l.warn).not.toHaveBeenCalled();
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
    // Two reads - the budget and the selection; no re-check, no ban, no purge, no signal.
    expect(sqls(db)).toEqual([RETIRED_BUDGET_SPENT_SQL, RETIRED_DEVICE_PREDICATE_SQL]);
    expect(m.purgeDeviceFootprint).not.toHaveBeenCalled();
    expect(m.notifyDeviceRevoked).not.toHaveBeenCalled();
    expect(run).toMatchObject({ mode: 'dry-run', matched: 3, revoked: 0 });
    const lines = l.log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((x) => x.includes('would revoke'))).toHaveLength(2);
    expect(lines[lines.length - 1]).toMatch(/mode=dry-run matched=3 listed=2 .* nothing written/);
  });

  it('ON limits the selection to what is LEFT of the daily budget', async () => {
    const db = database([candidate('web-a'), candidate('web-b'), candidate('web-c')], {
      spent: RETIRED_DEVICE_DAILY_BUDGET - 2,
    });
    const run = await runRetiredDeviceReaper({
      mode: 'on',
      db,
      messaging: messaging(),
      logger: logger(),
    });
    const selection = db.query.mock.calls.find(
      (c) => c[0] === RETIRED_DEVICE_PREDICATE_SQL && (c[1] as unknown[])[5] === null
    );
    expect(selection).toBeDefined();
    expect((selection![1] as unknown[])[3]).toBe(2);
    expect(run).toMatchObject({ budgetLeft: 2, revoked: 2 });
  });

  it('ON with the budget spent selects nothing, and says so at WARN', async () => {
    const db = database([candidate('web-a')], { spent: RETIRED_DEVICE_DAILY_BUDGET });
    const m = messaging();
    const l = logger();
    const run = await runRetiredDeviceReaper({ mode: 'on', db, messaging: m, logger: l });
    expect(sqls(db)).toEqual([RETIRED_BUDGET_SPENT_SQL]);
    expect(m.purgeDeviceFootprint).not.toHaveBeenCalled();
    expect(run.revoked).toBe(0);
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/daily budget of 100 spent/));
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
    // Per device: budget, re-check, owner sign-in, ban - in that order.
    const perDevice = sqls(db).slice(2);
    expect(perDevice.slice(0, 3)).toEqual([
      RETIRED_BUDGET_SPENT_SQL,
      RETIRED_DEVICE_PREDICATE_SQL,
      OWNER_UNBOUND_SESSION_SQL,
    ]);
    const bans = db.query.mock.calls.filter((c) => String(c[0]).includes('revoked_device ('));
    expect(bans.map((c) => (c[1] as unknown[])[4])).toEqual(['retired', 'retired']);
    expect(m.purgeDeviceFootprint).toHaveBeenCalledWith('u-web-a', 'web-a', {
      recordKeyGroupsHeld: true,
    });
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/mode=on matched=3 .* revoked=2/));
  });

  it('a device that no longer matches at the re-check is kept', async () => {
    const db = database([candidate('web-a'), candidate('web-b')], { gone: ['web-a'] });
    const m = messaging();
    const run = await runRetiredDeviceReaper({ mode: 'on', db, messaging: m, logger: logger() });
    expect(run).toMatchObject({ revoked: 1, skipped: 1 });
    expect(m.purgeDeviceFootprint).toHaveBeenCalledTimes(1);
    expect(m.purgeDeviceFootprint).toHaveBeenCalledWith('u-web-b', 'web-b', expect.anything());
  });

  it('a device whose owner signed in since the selection, session not yet bound, is kept', async () => {
    const db = database([candidate('web-a'), candidate('web-b')], { signedIn: ['u-web-a'] });
    const m = messaging();
    const l = logger();
    const run = await runRetiredDeviceReaper({ mode: 'on', db, messaging: m, logger: l });
    expect(run).toMatchObject({ revoked: 1, skipped: 1 });
    expect(m.purgeDeviceFootprint).toHaveBeenCalledWith('u-web-b', 'web-b', expect.anything());
    // The session check is asked from the selection's instant, not from now.
    const asked = db.query.mock.calls.find((c) => c[0] === OWNER_UNBOUND_SESSION_SQL);
    expect(asked).toBeDefined();
    expect((asked![1] as unknown[])[1]).toBeInstanceOf(Date);
    expect(l.log).toHaveBeenCalledWith(expect.stringMatching(/kept user=u-web-a .* signed in/));
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
