import type { DataSource, Repository } from 'typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import type { User } from './entities/user.entity';
import type { UserBlocksService } from './user-blocks.service';
import type { AvatarService } from './avatar.service';
import type { ProfileEditService } from './profile-edit.service';
import type { ProfileCorrectionService } from './profile-correction.service';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import type { AuthSessionsService } from '../auth/auth-sessions.service';
import { RefusalCode, refusalBody } from '../common/refusal-codes';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { SetAdminDto } from './dto/user.dto';

/**
 * ONE STABLE `code` PER USER-ACTIONABLE REFUSAL of the core service outside the block list (whose
 * cases live in `user-blocks.service.spec.ts`). The client words a refusal from its code and never
 * reads `message`, which stays beside it so an older client reads what it always read.
 */
describe('core-service refusal codes', () => {
  it('keeps the old message text beside the code', () => {
    expect(refusalBody(RefusalCode.BLOCK_SELF, 'You cannot block yourself')).toEqual({
      code: 'BLOCK_SELF',
      message: 'You cannot block yourself',
    });
  });

  it('names every code by itself - the value is the key, so a rename cannot go unnoticed', () => {
    for (const [key, value] of Object.entries(RefusalCode)) expect(value).toBe(key);
  });

  describe('the admin flag', () => {
    const make = () => {
      const users = { setAdmin: jest.fn().mockResolvedValue(undefined) };
      const sessions = { revokeOthers: jest.fn().mockResolvedValue(2) };
      const controller = new UsersController(
        users as unknown as UsersService,
        {} as AvatarService,
        {} as UserBlocksService,
        {} as ProfileEditService,
        {} as ProfileCorrectionService,
        {} as AccountErasureService,
        sessions as unknown as AuthSessionsService
      );
      return { controller, users, sessions };
    };
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('ADMIN_SELF_DEMOTE: an administrator cannot remove their own right', async () => {
      const { controller, users } = make();
      await expect(controller.setAdmin('U1', 'u1', { admin: false })).rejects.toMatchObject({
        response: { code: 'ADMIN_SELF_DEMOTE' },
      });
      expect(users.setAdmin).not.toHaveBeenCalled();
    });

    it('ADMIN_SELF_CHANGE: nobody writes their own flag, granting included', async () => {
      const { controller, users } = make();
      await expect(controller.setAdmin('u1', 'u1', { admin: true })).rejects.toMatchObject({
        status: 403,
        response: { code: 'ADMIN_SELF_CHANGE' },
      });
      expect(users.setAdmin).not.toHaveBeenCalled();
    });

    it('a removal ends every session of the person; a grant ends none', async () => {
      const { controller, sessions } = make();
      await controller.setAdmin('target', 'other', { admin: false });
      expect(sessions.revokeOthers).toHaveBeenCalledWith('target', null);
      sessions.revokeOthers.mockClear();
      await controller.setAdmin('target', 'other', { admin: true });
      expect(sessions.revokeOthers).not.toHaveBeenCalled();
    });

    it.each([[{}], [{ admin: 'false' }], [{ admin: 0 }], [{ admin: null }]])(
      'a body that is not a boolean is a 400 (%j)',
      async (body) => {
        const pipe = new ValidationPipe({ whitelist: true, transform: true });
        await expect(
          pipe.transform(body, { type: 'body', metatype: SetAdminDto })
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    );
  });

  describe('people search', () => {
    const service = new UsersService(
      {} as Repository<User>,
      {} as DataSource,
      {} as UserBlocksService
    );

    it('USER_SEARCH_TOO_LONG: a query past 200 characters', async () => {
      await expect(service.search('a'.repeat(201))).rejects.toMatchObject({
        response: { code: 'USER_SEARCH_TOO_LONG', max: 200 },
      });
    });

    it('USER_SEARCH_FILTER_REQUIRED: a directory query with no filter at all', async () => {
      await expect(service.directory({} as never)).rejects.toMatchObject({
        response: { code: 'USER_SEARCH_FILTER_REQUIRED' },
      });
    });
  });
});
