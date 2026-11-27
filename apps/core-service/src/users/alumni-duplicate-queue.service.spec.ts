import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { DataSource } from 'typeorm';
import { ALUMNI_FOUND_BATCH, AlumniDuplicateQueue } from './alumni-duplicate-queue.service';

jest.mock('axios');

const DUP = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * The flags table as an array and the queries the service runs, answered by their shape: the
 * INSERT (new uuid -> one row, known -> none), the reopen and the resolve (counts over the rows).
 * The SQL itself - what "pending" means once a merge stands - is proved against PostgreSQL in
 * social-service's `bell-target-rows.integration.spec`.
 */
function make(
  initial: {
    uuid: string;
    resolved?: boolean;
    dismissed?: boolean;
    announced?: boolean;
    flaggedAt?: Date;
  }[] = []
) {
  const flags = initial.map((f) => ({
    uuid: f.uuid,
    resolved: f.resolved ?? false,
    dismissed: f.dismissed ?? false,
    announced: f.announced ?? true,
    flaggedAt: f.flaggedAt ?? new Date(0),
  }));
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT now()')) return [{ t: new Date('2026-11-27T10:00:00Z') }];
    if (sql.includes('ON CONFLICT ("duplicateUuid") DO UPDATE')) {
      const flag = flags.find((f) => f.uuid === params[0]);
      if (flag) Object.assign(flag, { dismissed: true, resolved: true });
      else
        flags.push({
          uuid: params[0] as string,
          resolved: true,
          dismissed: true,
          announced: false,
          flaggedAt: new Date(),
        });
      return [];
    }
    if (sql.startsWith('INSERT INTO alumni_duplicate_flags')) {
      if (flags.some((f) => f.uuid === params[0])) return [];
      flags.push({
        uuid: params[0] as string,
        resolved: false,
        dismissed: false,
        announced: false,
        flaggedAt: new Date(),
      });
      return [{ duplicateUuid: params[0] }];
    }
    if (sql.includes('SET "resolvedAt" = NULL')) {
      const flag = flags.find((f) => f.uuid === params[0] && f.resolved && !f.dismissed);
      if (flag) flag.resolved = false;
      return [{ n: flag ? 1 : 0 }];
    }
    if (sql.includes('SET "resolvedAt" = now()')) {
      const listed = params[0] as string[];
      const began = params[1] as Date;
      const gone = flags.filter(
        (f) => !f.resolved && f.flaggedAt < began && !listed.includes(f.uuid)
      );
      gone.forEach((f) => (f.resolved = true));
      return [{ n: gone.length }];
    }
    if (sql.startsWith('SELECT f."duplicateUuid"')) {
      return flags.filter((f) => !f.announced && !f.resolved).map((f) => ({ uuid: f.uuid }));
    }
    if (sql.includes('SET "announcedAt" = now()')) {
      for (const f of flags) if ((params[0] as string[]).includes(f.uuid)) f.announced = true;
      return [];
    }
    if (sql.includes('"dismissedAt" IS NOT NULL')) {
      return flags
        .filter((f) => f.dismissed && (params[0] as string[]).includes(f.uuid))
        .map((f) => ({ uuid: f.uuid }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const queue = new AlumniDuplicateQueue({ query } as unknown as DataSource);
  return { queue, flags, query };
}

const posted = () => (axios.post as jest.Mock).mock.calls.map((c) => c[0] as string);
const found = () =>
  (axios.post as jest.Mock).mock.calls
    .filter((c) => String(c[0]).includes('alumni-duplicates-found'))
    .map((c) => (c[1] as { duplicateUuids: string[] }).duplicateUuids);
const NOW = () => new Date(Date.now() + 1000);

describe('AlumniDuplicateQueue', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    (axios.post as jest.Mock).mockReset().mockResolvedValue({ data: {} });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('tells the admins of a duplicate ONCE, at the first finding, naming only its uuid, and records it', async () => {
    const { queue, flags } = make();
    await queue.flag(DUP);
    expect(found()).toEqual([[DUP]]);
    expect(flags[0].announced).toBe(true);
  });

  it('reads the database clock for a reading start', async () => {
    expect((await make().queue.databaseNow()).toISOString()).toBe('2026-11-27T10:00:00.000Z');
  });

  it('never tells them again of a duplicate it already holds, however often the page is read', async () => {
    const { queue } = make([{ uuid: DUP }]);
    await queue.flag(DUP);
    await queue.reconcile([DUP], NOW());
    await queue.reconcile([DUP], NOW());
    expect(posted()).toEqual([]);
  });

  it('a resolved duplicate that matches again waits again: the badges recount, NO new notice', async () => {
    const { queue, flags } = make([{ uuid: DUP, resolved: true }]);
    await queue.flag(DUP);
    expect(flags[0].resolved).toBe(false);
    expect(posted()).toEqual([expect.stringContaining('alumni-duplicates-changed')]);
  });

  it('resolves the flags the page no longer lists, and tells the badges once', async () => {
    const { queue, flags } = make([{ uuid: DUP }, { uuid: OTHER }]);
    await queue.reconcile([OTHER], NOW());
    expect(flags.find((f) => f.uuid === DUP)?.resolved).toBe(true);
    expect(flags.find((f) => f.uuid === OTHER)?.resolved).toBe(false);
    expect(posted()).toEqual([expect.stringContaining('alumni-duplicates-changed')]);
  });

  it('a reading resolves only the flags older than itself: one a sign-in made while it ran stays', async () => {
    const began = new Date();
    const { queue, flags } = make([
      { uuid: DUP, flaggedAt: new Date(began.getTime() - 5000) },
      { uuid: OTHER, flaggedAt: new Date(began.getTime() + 5000) },
    ]);
    await queue.reconcile([], began);
    expect(flags.find((f) => f.uuid === DUP)?.resolved).toBe(true);
    expect(flags.find((f) => f.uuid === OTHER)?.resolved).toBe(false);
  });

  it('a reading that flags several duplicates sends ONE announcement for all of them (one bell row, social decides), never one each', async () => {
    const third = '33333333-3333-4333-8333-333333333333';
    const { queue, flags } = make();
    await queue.reconcile([DUP, OTHER, third], NOW());
    expect(flags).toHaveLength(3);
    expect(found()).toEqual([[DUP, OTHER, third]]);
    expect(posted()).toHaveLength(1);
  });

  it('a sign-in flag keeps its own announcement, one per duplicate', async () => {
    const { queue } = make();
    await queue.flag(DUP);
    await queue.flag(OTHER);
    expect(found()).toEqual([[DUP], [OTHER]]);
  });

  it('keeps the flag a merge stands for out of the resolution, whatever the page lists', async () => {
    const { queue, query } = make([{ uuid: DUP }]);
    await queue.reconcile([], NOW());
    const resolve = query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('now()'));
    expect(resolve).toContain('alumni_merges');
    expect(resolve).toContain('"cancelledAt" IS NULL');
    expect(resolve).toContain('"flaggedAt" < $2');
  });

  it('says a notice social did not confirm at error, keeps the flag counted, and tells it AGAIN at the next reading', async () => {
    (axios.post as jest.Mock).mockRejectedValueOnce(new Error('social down'));
    const { queue, flags } = make();
    await expect(queue.flag(DUP)).resolves.toBe('created');
    expect(flags).toHaveLength(1);
    expect(flags[0].announced).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT confirmed'));
    await queue.reconcile([DUP], NOW());
    expect(found()).toEqual([[DUP], [DUP]]);
    expect(flags[0].announced).toBe(true);
    await queue.reconcile([DUP], NOW());
    expect(found()).toHaveLength(2);
  });

  it('a backlog goes out in batches of at most ALUMNI_FOUND_BATCH, and a failing batch drops neither the others nor itself for good', async () => {
    const uuids = Array.from(
      { length: ALUMNI_FOUND_BATCH + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    (axios.post as jest.Mock).mockRejectedValueOnce(new Error('400'));
    const { queue, flags } = make();
    await queue.reconcile(uuids, NOW());
    const sent = found();
    expect(sent.map((b) => b.length)).toEqual([ALUMNI_FOUND_BATCH, 5]);
    // The first batch failed: its 200 stay owed, the 5 of the second landed.
    expect(flags.filter((f) => f.announced)).toHaveLength(5);
    await queue.reconcile(uuids, NOW());
    expect(found().map((b) => b.length)).toEqual([ALUMNI_FOUND_BATCH, 5, ALUMNI_FOUND_BATCH]);
    expect(flags.every((f) => f.announced)).toBe(true);
  });

  it('"Pas un doublon" is TERMINAL: a later reading or sign-in neither flags nor reopens it, and it is never told', async () => {
    const { queue, flags } = make([{ uuid: DUP }]);
    await queue.dismiss(DUP);
    expect(flags[0]).toMatchObject({ dismissed: true, resolved: true });
    (axios.post as jest.Mock).mockClear();
    expect(await queue.flag(DUP)).toBe('known');
    await queue.reconcile([DUP], NOW());
    expect(flags[0]).toMatchObject({ dismissed: true, resolved: true });
    expect(found()).toEqual([]);
    expect([...(await queue.dismissedAmong([DUP, OTHER]))]).toEqual([DUP]);
  });

  it('dismisses an account never flagged: the row is written dismissed, never told', async () => {
    const { queue, flags } = make();
    await queue.dismiss(DUP);
    expect(flags).toEqual([
      expect.objectContaining({ uuid: DUP, dismissed: true, resolved: true }),
    ]);
    await queue.reconcile([DUP], NOW());
    expect(found()).toEqual([]);
    expect(posted().every((u) => u.includes('alumni-duplicates-changed'))).toBe(true);
  });

  it('never throws on a failed read of the table: the page is answered, the failure accused', async () => {
    const queue = new AlumniDuplicateQueue({
      query: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as DataSource);
    await expect(queue.reconcile([DUP], NOW())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT flagged'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT reconciled'));
  });

  it('a badge that cannot be told is said at error, never thrown', async () => {
    (axios.post as jest.Mock).mockRejectedValueOnce(new Error('social down'));
    const { queue } = make();
    await expect(queue.changed()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('badges were NOT told'));
  });
});
