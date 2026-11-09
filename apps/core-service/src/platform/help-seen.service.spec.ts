/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { HelpSeenService } from './help-seen.service';
import type { Repository } from 'typeorm';
import type { HelpSeen } from './entities/help-seen.entity';

/** The read keeps only ids the CURRENT allowlist names; the write is an insert that ignores a repeat. */
describe('HelpSeenService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('hands back only the ids the allowlist still names, with their server-side age', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-30T00:00:00Z'));
    const repo = {
      find: jest.fn(async () => [
        { helpId: 'welcome-tour', seenAt: new Date('2026-11-29T23:00:00Z') },
        { helpId: 'retired-hint', seenAt: new Date('2026-01-01T00:00:00Z') },
      ]),
    };
    const service = new HelpSeenService(repo as unknown as Repository<HelpSeen>);
    await expect(service.seenWithAges('u1')).resolves.toEqual({
      seen: ['welcome-tour'],
      ageSeconds: { 'welcome-tour': 3600 },
    });
    expect(repo.find).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { helpId: true, seenAt: true },
    });
    jest.useRealTimers();
  });

  it('writes with ON CONFLICT DO NOTHING, so a repeat changes nothing', async () => {
    const qb = {
      insert: jest.fn(() => qb),
      values: jest.fn(() => qb),
      orIgnore: jest.fn(() => qb),
      execute: jest.fn(async () => undefined),
    };
    const repo = { createQueryBuilder: jest.fn(() => qb) };
    const service = new HelpSeenService(repo as unknown as Repository<HelpSeen>);
    await service.markSeen('u1', 'welcome-tour');
    expect(qb.values).toHaveBeenCalledWith({ userId: 'u1', helpId: 'welcome-tour' });
    expect(qb.orIgnore).toHaveBeenCalled();
  });
});
