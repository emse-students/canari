/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { ActivitySettingsService } from './activity-settings.controller';
import { sharesActivitySql } from './engagement-sql';

/**
 * "Partager mon activité" is OFF until turned on ("Nos principes", owner 2026-11-10): the route reads
 * the setting through THE predicate the campus trend asks, so the screen and the naming cannot
 * disagree. The predicate itself is proven on PostgreSQL (`campus-trend.integration.spec.ts`).
 */
describe('ActivitySettingsService.read', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  const service = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { query, svc: new ActivitySettingsService({ query } as never) };
  };

  it('asks the one predicate, for the caller', async () => {
    const { query, svc } = service([{ shareActivity: false }]);
    await svc.read('u1');
    expect(query).toHaveBeenCalledWith(
      `SELECT ${sharesActivitySql('$1::varchar')} AS "shareActivity"`,
      ['u1']
    );
  });

  it('answers off for an account that never chose, and on only for an explicit yes', async () => {
    expect(await service([{ shareActivity: false }]).svc.read('u1')).toEqual({
      shareActivity: false,
    });
    expect(await service([]).svc.read('u1')).toEqual({ shareActivity: false });
    expect(await service([{ shareActivity: true }]).svc.read('u1')).toEqual({
      shareActivity: true,
    });
  });

  it('the predicate shares only on a row that says true - no row is off', () => {
    const sql = sharesActivitySql('x');
    expect(sql).toMatch(/^EXISTS \(/);
    expect(sql).toContain('"shareActivity")');
    expect(sql).not.toContain('NOT');
  });
});
