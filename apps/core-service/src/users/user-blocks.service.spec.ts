import type { Repository } from 'typeorm';
import { UserBlocksService } from './user-blocks.service';
import type { UserBlock } from './entities/user-block.entity';
import type { User } from './entities/user.entity';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * The two things a block has to get right are both about SYMMETRY and about SCOPE:
 * the exclusion must answer for both directions, and blocking must not reach past the paths it was
 * asked to close. Everything below tests one of those two.
 */
describe('UserBlocksService', () => {
  let service: UserBlocksService;
  let blockRepo: jest.Mocked<
    Pick<Repository<UserBlock>, 'find' | 'findOne' | 'count' | 'save' | 'create' | 'delete'>
  > & { manager: { query: jest.Mock } };
  let userRepo: { findOne: jest.Mock; manager: { query: jest.Mock } };
  // Held by name rather than read back off `axios`: referencing the module's own method in an
  // assertion is an unbound-method reference, and oxlint is right to say so.
  let severFollows: jest.Mock;

  beforeEach(() => {
    blockRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockImplementation((row) => Promise.resolve(row)),
      create: jest.fn().mockImplementation((row) => row),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: { query: jest.fn().mockResolvedValue([]) },
    } as never;
    userRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'bob' }),
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    severFollows = jest.fn().mockResolvedValue({ data: { ok: true } });
    mockedAxios.delete = severFollows;
    service = new UserBlocksService(
      blockRepo as unknown as Repository<UserBlock>,
      userRepo as unknown as Repository<User>
    );
  });

  describe('invisibleUserIdsFor', () => {
    it('unions both directions, so the blocked party stops finding the blocker too', async () => {
      blockRepo.manager.query.mockResolvedValue([{ otherId: 'bob' }, { otherId: 'carol' }]);

      const hidden = await service.invisibleUserIdsFor('alice');

      expect(hidden).toEqual(['bob', 'carol']);
      const sql = blockRepo.manager.query.mock.calls[0][0] as string;
      // The half that matters: without the second branch, blocking would only hide the blocker's
      // own view and would leave the blocked person able to search for them.
      expect(sql).toContain('WHERE "blockerId" = $1');
      expect(sql).toContain('WHERE "blockedId" = $1');
    });

    it('asks nothing for an anonymous caller', async () => {
      expect(await service.invisibleUserIdsFor('')).toEqual([]);
      expect(blockRepo.manager.query).not.toHaveBeenCalled();
    });
  });

  describe('isBlockedBetween', () => {
    it('is true whichever of the two asked for the block', async () => {
      blockRepo.manager.query.mockResolvedValue([{ '?column?': 1 }]);
      expect(await service.isBlockedBetween('alice', 'bob')).toBe(true);
      const sql = blockRepo.manager.query.mock.calls[0][0] as string;
      expect(sql).toContain('"blockerId" = $1 AND "blockedId" = $2');
      expect(sql).toContain('"blockerId" = $2 AND "blockedId" = $1');
    });

    it('never reports a block between an account and itself', async () => {
      expect(await service.isBlockedBetween('alice', 'alice')).toBe(false);
      expect(blockRepo.manager.query).not.toHaveBeenCalled();
    });
  });

  describe('block', () => {
    it('severs both follows, because staying subscribed to someone you blocked is a state nobody asked for', async () => {
      blockRepo.findOne.mockResolvedValue(null);

      await service.block('alice', 'bob');

      expect(blockRepo.save).toHaveBeenCalledWith({ blockerId: 'alice', blockedId: 'bob' });
      expect(severFollows).toHaveBeenCalledWith(
        expect.stringContaining('internal/follows/between/alice/bob'),
        expect.anything()
      );
    });

    it('still blocks when social-service cannot be reached - the block is the durable half', async () => {
      blockRepo.findOne.mockResolvedValue(null);
      severFollows = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      mockedAxios.delete = severFollows;

      await expect(service.block('alice', 'bob')).resolves.toEqual({ ok: true });
      expect(blockRepo.save).toHaveBeenCalled();
    });

    it('is idempotent: blocking twice writes nothing the second time', async () => {
      blockRepo.findOne.mockResolvedValue({ id: 'existing' } as UserBlock);

      await service.block('alice', 'bob');

      expect(blockRepo.save).not.toHaveBeenCalled();
      expect(severFollows).not.toHaveBeenCalled();
    });

    it('refuses to block yourself', async () => {
      await expect(service.block('alice', 'alice')).rejects.toThrow('You cannot block yourself');
    });

    it('refuses an account that does not exist', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.block('alice', 'ghost')).rejects.toThrow('User not found');
    });

    it('refuses past the cap, which exists to bound the search exclusion and not the user', async () => {
      blockRepo.findOne.mockResolvedValue(null);
      blockRepo.count.mockResolvedValue(200);
      await expect(service.block('alice', 'bob')).rejects.toThrow('more than 200');
    });
  });

  describe('unblock', () => {
    it('refuses when there is nothing to lift', async () => {
      blockRepo.delete.mockResolvedValue({ affected: 0, raw: [] });
      await expect(service.unblock('alice', 'bob')).rejects.toThrow('not blocked');
    });

    it('deletes only the row the caller owns, so a block cannot be lifted by its target', async () => {
      await service.unblock('alice', 'bob');
      expect(blockRepo.delete).toHaveBeenCalledWith({ blockerId: 'alice', blockedId: 'bob' });
    });
  });

  it('deleteAllFor sweeps both directions, so no row names a deleted account', async () => {
    await service.deleteAllFor('alice');
    const sql = blockRepo.manager.query.mock.calls[0][0] as string;
    expect(sql).toContain('"blockerId" = $1 OR "blockedId" = $1');
  });

  // Guards a claim made in the class docblock rather than a branch: nothing here reports a block to
  // anyone but the two people, by the user's decision of 2026-08-27.
  it('exposes no aggregate or administrative view of blocks', () => {
    const surface = Object.getOwnPropertyNames(UserBlocksService.prototype);
    expect(surface).not.toContain('countBlocksAgainst');
    expect(surface.filter((n) => /count|stats|admin/i.test(n))).toEqual([]);
  });
});
