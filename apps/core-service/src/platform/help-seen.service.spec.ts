/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { HelpSeenService } from './help-seen.service';
import type { Repository } from 'typeorm';
import type { HelpSeen } from './entities/help-seen.entity';
import type { User } from '../users/entities/user.entity';

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
    const service = new HelpSeenService(
      repo as unknown as Repository<HelpSeen>,
      {} as Repository<User>
    );
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
    const service = new HelpSeenService(
      repo as unknown as Repository<HelpSeen>,
      {} as Repository<User>
    );
    await service.markSeen('u1', 'welcome-tour');
    expect(qb.values).toHaveBeenCalledWith({ userId: 'u1', helpId: 'welcome-tour' });
    expect(qb.orIgnore).toHaveBeenCalled();
  });
});

/** The profile-photo prompt's gate (TEMPORARY, owner 2026-11-10): ICM at Saint-Etienne only. */
describe('HelpSeenService.profilePhotoPromptEligible', () => {
  const ENV = 'PROFILE_PHOTO_PROMPT_SPACES';
  const saved = process.env[ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    jest.restoreAllMocks();
  });

  /** A service built AFTER the variable is set, over a users repo answering `profile`. */
  function serviceFor(value: string | undefined, profile: object | null) {
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    const users = { findOne: jest.fn(async () => profile) };
    const service = new HelpSeenService(
      {} as Repository<HelpSeen>,
      users as unknown as Repository<User>
    );
    return { service, users };
  }
  const icmStEtienne = {
    id: 'u1',
    campus: 'saint-etienne',
    cursus: [{ formation: 'ICM', promo: 2027 }],
  };

  it('prompts an ICM account at Saint-Etienne', async () => {
    const { service } = serviceFor('ICM:saint-etienne', icmStEtienne);
    await expect(service.profilePhotoPromptEligible('u1')).resolves.toBe(true);
  });

  it('prompts ICM among several formations, but not ICM at Gardanne', async () => {
    const both = {
      ...icmStEtienne,
      cursus: [{ formation: 'ISMIN', promo: 2025 }, ...icmStEtienne.cursus],
    };
    await expect(
      serviceFor('ICM:saint-etienne', both).service.profilePhotoPromptEligible('u1')
    ).resolves.toBe(true);
    await expect(
      serviceFor('ICM:saint-etienne', {
        ...icmStEtienne,
        campus: 'gardanne',
      }).service.profilePhotoPromptEligible('u1')
    ).resolves.toBe(false);
  });

  it('does not prompt another formation at Saint-Etienne, nor staff with no cursus or no campus', async () => {
    for (const profile of [
      { ...icmStEtienne, cursus: [{ formation: 'ISMIN', promo: 2027 }] },
      { ...icmStEtienne, cursus: [] },
      { ...icmStEtienne, campus: null },
      null,
    ]) {
      await expect(
        serviceFor('ICM:saint-etienne', profile).service.profilePhotoPromptEligible('u1')
      ).resolves.toBe(false);
    }
  });

  it('prompts nobody when the variable is unset or empty, without reading a profile', async () => {
    for (const value of [undefined, '', '  ']) {
      const { service, users } = serviceFor(value, icmStEtienne);
      await expect(service.profilePhotoPromptEligible('u1')).resolves.toBe(false);
      expect(users.findOne).not.toHaveBeenCalled();
    }
  });

  it('prompts nobody on a value that does not parse, and says so loudly at boot', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    for (const value of ['ICM:Saint-Etienne', 'ICM', 'NOPE:gardanne', 'ICM:saint-etienne,oops']) {
      const { service } = serviceFor(value, icmStEtienne);
      service.onModuleInit();
      await expect(service.profilePhotoPromptEligible('u1')).resolves.toBe(false);
    }
    expect(error).toHaveBeenCalledTimes(4);
  });

  it('logs once at boot what the variable resolved to', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    serviceFor('ICM:saint-etienne', null).service.onModuleInit();
    serviceFor(undefined, null).service.onModuleInit();
    expect(log).toHaveBeenNthCalledWith(1, expect.stringContaining('= ICM:saint-etienne'));
    expect(log).toHaveBeenNthCalledWith(2, expect.stringContaining('(unset) - nobody is prompted'));
  });
});
