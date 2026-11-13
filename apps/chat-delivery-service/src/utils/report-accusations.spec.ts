/// <reference types="jest" />

import { memoryAccusationLedger } from '../testing/memoryAccusationLedger';
import { REPORT_KINDS, settleAccusations, summarizeAccusations } from './report-accusations';

/**
 * The ledger's decisions, on the in-memory table: first sighting accused, same state known, changed
 * state accused again, an item no longer named leaves once; and the daily summary prints one line per
 * report, zero included. The SQL behind each is proven by `report-accusations.integration.spec.ts`.
 */
describe('report accusations', () => {
  const labels = Object.fromEntries(
    Object.values(REPORT_KINDS).map((k) => [k, { prefix: `[${k}]`, items: 'item(s)' }])
  ) as Parameters<typeof summarizeAccusations>[2];

  it('accuses, then counts, then accuses a changed state, then releases once', async () => {
    const db = memoryAccusationLedger();
    const logger = { log: jest.fn() };
    const settle = (items: { id: string; state: string }[]) =>
      settleAccusations(db, REPORT_KINDS.commitLogHole, items, logger, '[it]');

    expect((await settle([{ id: 'g', state: 'a' }])).fresh).toHaveLength(1);
    const same = await settle([{ id: 'g', state: 'a' }]);
    expect(same.fresh).toHaveLength(0);
    expect(same.known).toHaveLength(1);
    expect((await settle([{ id: 'g', state: 'b' }])).fresh).toHaveLength(1);

    expect((await settle([])).left.map((l) => l.itemId)).toEqual(['g']);
    expect((await settle([])).left).toEqual([]);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(String(logger.log.mock.calls[0][0])).toContain('[it]: 1 item(s) accused earlier');
  });

  it('prints one daily line per report, the known count and its dates, zero included', async () => {
    const db = memoryAccusationLedger(() => new Date('2026-11-13T08:00:00Z'));
    await settleAccusations(
      db,
      REPORT_KINDS.holders,
      [
        { id: 'g1', state: 'holders 0' },
        { id: 'g2', state: 'holders 0' },
      ],
      { log: jest.fn() },
      '[it]'
    );
    const logger = { log: jest.fn() };

    await summarizeAccusations(db, logger, labels);

    const lines = logger.log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(Object.keys(REPORT_KINDS).length);
    expect(lines.find((l) => l.startsWith('[holders]'))).toBe(
      '[holders]: daily summary - 2 item(s) already accused, unchanged since ' +
        '2026-11-13T08:00:00.000Z (first accused 2026-11-13T08:00:00.000Z); a new item or a ' +
        'changed state is accused on the hour it appears'
    );
    expect(lines.find((l) => l.startsWith('[commit_log_hole]'))).toBe(
      '[commit_log_hole]: daily summary - 0 item(s) already accused'
    );
  });
});
