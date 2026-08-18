/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { AnnouncementService } from './announcement.service';
import { PlatformAnnouncement } from './entities/platform-announcement.entity';
import { PlatformAnnouncementSeen } from './entities/platform-announcement-seen.entity';

/**
 * The announcement is shown ONCE PER ACCOUNT, and every property that makes that true is here:
 * a seen row silences it everywhere, the version range filters silently rather than refusing, and
 * publishing retires the old row in the same transaction as the insert.
 *
 * The silence matters as much as the showing. "A client outside the range must not be told an
 * announcement exists and refused it; it must simply have none" - so the three reasons for null are
 * deliberately indistinguishable to the caller, and a test that let them diverge would be pinning
 * the leak rather than the contract.
 */
describe('AnnouncementService', () => {
  let service: AnnouncementService;

  const ACTIVE = {
    id: 'a1',
    titleFr: 'Nouveaute',
    titleEn: 'What is new',
    bodyFr: 'Corps',
    bodyEn: 'Body',
    minClientVersion: null as string | null,
    maxClientVersion: null as string | null,
    active: true,
    createdBy: 'admin-uuid',
    createdAt: new Date('2026-08-18T10:00:00Z'),
  };

  const repo = {
    findOne: jest.fn(),
    update: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };

  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };

  const seenRepo = {
    findOne: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(() => insertBuilder),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnnouncementService,
        { provide: getRepositoryToken(PlatformAnnouncement), useValue: repo },
        { provide: getRepositoryToken(PlatformAnnouncementSeen), useValue: seenRepo },
      ],
    }).compile();
    service = module.get(AnnouncementService);
  });

  describe('getForUser', () => {
    it('hands over both languages, so the client picks and the server never composes', async () => {
      repo.findOne.mockResolvedValue({ ...ACTIVE });
      seenRepo.findOne.mockResolvedValue(null);

      const got = await service.getForUser('u1', '0.14.0');

      expect(got).toEqual({
        id: 'a1',
        titleFr: 'Nouveaute',
        titleEn: 'What is new',
        bodyFr: 'Corps',
        bodyEn: 'Body',
      });
    });

    it('says nothing once the ACCOUNT has seen it, whatever device asks', async () => {
      repo.findOne.mockResolvedValue({ ...ACTIVE });
      seenRepo.findOne.mockResolvedValue({ announcementId: 'a1', userId: 'u1' });

      expect(await service.getForUser('u1', '0.14.0')).toBeNull();
      // The second device of the same account asks separately and is answered the same way.
      expect(await service.getForUser('u1', '0.15.0')).toBeNull();
    });

    it('is null in the same way for every reason there is nothing to show', async () => {
      // No announcement at all.
      repo.findOne.mockResolvedValue(null);
      const none = await service.getForUser('u1', '0.14.0');

      // Out of range: told nothing, not refused.
      repo.findOne.mockResolvedValue({ ...ACTIVE, minClientVersion: '0.15.0' });
      seenRepo.findOne.mockResolvedValue(null);
      const tooOld = await service.getForUser('u1', '0.14.0');

      // Already seen.
      repo.findOne.mockResolvedValue({ ...ACTIVE });
      seenRepo.findOne.mockResolvedValue({ announcementId: 'a1', userId: 'u1' });
      const seen = await service.getForUser('u1', '0.14.0');

      expect([none, tooOld, seen]).toEqual([null, null, null]);
    });

    it('applies each bound inclusively, and an absent bound not at all', async () => {
      seenRepo.findOne.mockResolvedValue(null);
      const cases: [string | null, string | null, string, boolean][] = [
        ['0.15.0', null, '0.15.0', true], // lower bound is inclusive
        ['0.15.0', null, '0.14.9', false],
        [null, '0.15.0', '0.15.0', true], // upper bound is inclusive
        [null, '0.15.0', '0.15.1', false],
        ['0.14.0', '0.15.0', '0.14.7', true],
        [null, null, '0.1.0', true], // no bounds: everyone
      ];

      for (const [min, max, client, expected] of cases) {
        repo.findOne.mockResolvedValue({
          ...ACTIVE,
          minClientVersion: min,
          maxClientVersion: max,
        });
        const got = await service.getForUser('u1', client);
        expect([min, max, client, got !== null]).toEqual([min, max, client, expected]);
      }
    });

    it('shows nothing to a client whose version cannot be read', async () => {
      repo.findOne.mockResolvedValue({ ...ACTIVE, minClientVersion: '0.14.0' });
      seenRepo.findOne.mockResolvedValue(null);

      for (const bad of ['', 'unknown', '0.14', 'v0.14.0']) {
        expect(await service.getForUser('u1', bad)).toBeNull();
      }
    });

    it('shows an unbounded announcement even to a client whose version is unreadable', async () => {
      // No range means the announcement does not describe a build, so the version is irrelevant.
      repo.findOne.mockResolvedValue({ ...ACTIVE });
      seenRepo.findOne.mockResolvedValue(null);

      expect(await service.getForUser('u1', '')).not.toBeNull();
    });
  });

  describe('markSeen', () => {
    it('is a no-op on the second device rather than a duplicate-key error', async () => {
      await service.markSeen('u1', 'a1');

      expect(insertBuilder.orIgnore).toHaveBeenCalled();
      expect(insertBuilder.values).toHaveBeenCalledWith({ announcementId: 'a1', userId: 'u1' });
    });

    it('records the announcement that was actually read, not the active one', async () => {
      // A modal still open when a new announcement is published dismisses the one on screen.
      await service.markSeen('u1', 'older-announcement');

      expect(insertBuilder.values).toHaveBeenCalledWith({
        announcementId: 'older-announcement',
        userId: 'u1',
      });
      expect(repo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    it('retires the old row and inserts the new one in ONE transaction', async () => {
      const order: string[] = [];
      const tx = {
        getRepository: jest.fn(() => ({
          update: jest.fn(() => {
            order.push('retire');
            return Promise.resolve({ affected: 1 });
          }),
          save: jest.fn((row: Record<string, unknown>) => {
            order.push('insert');
            return Promise.resolve({ ...ACTIVE, ...row, id: 'a2' });
          }),
        })),
      };
      repo.manager.transaction.mockImplementation(async (cb: (m: typeof tx) => Promise<unknown>) =>
        cb(tx)
      );

      const published = await service.publish(
        {
          titleFr: '  Titre  ',
          titleEn: 'Title',
          bodyFr: 'Corps',
          bodyEn: 'Body',
          minClientVersion: '0.15.0',
          maxClientVersion: '',
        },
        'admin-uuid'
      );

      expect(order).toEqual(['retire', 'insert']);
      expect(published.id).toBe('a2');
      expect(published.titleFr).toBe('Titre');
      // An empty bound is no bound, never the empty string a range check would then compare against.
      expect(published.maxClientVersion).toBeNull();
      expect(published.minClientVersion).toBe('0.15.0');
      expect(published.seenCount).toBe(0);
    });
  });

  describe('retire', () => {
    it('refuses when nothing is published, rather than reporting a success it did not have', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.retire('admin-uuid')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('keeps the row and its readership - it is the record of who was told what', async () => {
      repo.findOne.mockResolvedValue({ ...ACTIVE });

      await service.retire('admin-uuid');

      expect(repo.update).toHaveBeenCalledWith({ id: 'a1' }, { active: false });
    });
  });
});
