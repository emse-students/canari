/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { HelpSeenService } from './help-seen.service';
import type { Repository } from 'typeorm';
import type { HelpSeen } from './entities/help-seen.entity';

/** The read keeps only ids the CURRENT allowlist names; the write is an insert that ignores a repeat. */
describe('HelpSeenService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('hands back only the ids the allowlist still names', async () => {
    const repo = {
      find: jest.fn(async () => [{ helpId: 'welcome-tour' }, { helpId: 'retired-hint' }]),
    };
    const service = new HelpSeenService(repo as unknown as Repository<HelpSeen>);
    await expect(service.seenBy('u1')).resolves.toEqual(['welcome-tour']);
    expect(repo.find).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { helpId: true } });
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
