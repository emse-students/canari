import { Logger } from '@nestjs/common';
import axios from 'axios';
import { QueryFailedError, type Repository } from 'typeorm';
import { ProfileCorrectionService } from './profile-correction.service';
import type { ProfileEditService } from './profile-edit.service';
import type { ProfileCorrectionRequest } from './entities/profile-correction-request.entity';
import type { User } from './entities/user.entity';
import {
  PROFILE_CORRECTION_CODES,
  ProfileCorrectionAlreadyPendingError,
  ProfileCorrectionInvalidError,
  ProfileCorrectionNotFoundError,
  ProfileCorrectionNotPendingError,
} from './profile-correction.errors';

const RID = '11111111-1111-4111-8111-111111111111';

const pending = (over: Partial<ProfileCorrectionRequest> = {}) =>
  ({
    id: RID,
    userId: 'u-1',
    message: 'My campus is wrong',
    status: 'pending',
    createdAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...over,
  }) as ProfileCorrectionRequest;

describe('ProfileCorrectionService', () => {
  let errorLog: jest.SpyInstance;
  let post: jest.SpyInstance;

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'internal';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
  });
  afterEach(() => jest.restoreAllMocks());

  function make(found: ProfileCorrectionRequest | null = pending()) {
    const requests = {
      create: jest.fn((v: object) => ({ ...v })),
      save: jest.fn(async (v: object) => ({ id: 'req-new', ...v })),
      findOne: jest.fn().mockResolvedValue(found),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const users = { find: jest.fn().mockResolvedValue([]) };
    const edit = {
      applyEdit: jest
        .fn()
        .mockResolvedValue({ user: { id: 'u-1' }, changed: true, changeId: 'chg' }),
    };
    const service = new ProfileCorrectionService(
      requests as unknown as Repository<ProfileCorrectionRequest>,
      users as unknown as Repository<User>,
      edit as unknown as ProfileEditService
    );
    return { service, requests, users, edit };
  }

  describe('create', () => {
    it('files a trimmed message', async () => {
      const { service, requests } = make();
      await service.create('u-1', '  wrong campus  ');
      expect(requests.create).toHaveBeenCalledWith({ userId: 'u-1', message: 'wrong campus' });
    });

    it.each([undefined, '', '   ', 'x'.repeat(1001), 42])('refuses %p', async (message) => {
      const { service, requests } = make();
      await expect(service.create('u-1', message)).rejects.toBeInstanceOf(
        ProfileCorrectionInvalidError
      );
      expect(requests.save).not.toHaveBeenCalled();
    });

    it('a second open request is the typed PENDING refusal, read from the driver code', async () => {
      const { service, requests } = make();
      requests.save.mockRejectedValue(
        Object.assign(new QueryFailedError('insert', [], new Error('dup')), {
          driverError: { code: '23505' },
        })
      );
      const attempt = service.create('u-1', 'again');
      await expect(attempt).rejects.toBeInstanceOf(ProfileCorrectionAlreadyPendingError);
      await expect(attempt).rejects.toMatchObject({
        response: { code: PROFILE_CORRECTION_CODES.alreadyPending },
      });
    });

    it('any other database failure is rethrown and logged, never mistaken for PENDING', async () => {
      const { service, requests } = make();
      requests.save.mockRejectedValue(new Error('connection lost'));
      await expect(service.create('u-1', 'x')).rejects.toThrow('connection lost');
      expect(errorLog).toHaveBeenCalled();
    });
  });

  describe('apply', () => {
    it('edits the REQUESTER, names the request, then tells them', async () => {
      const { service, edit } = make();
      await service.apply(RID, 'u-1', 'admin', { campus: 'gardanne' });
      expect(edit.applyEdit).toHaveBeenCalledWith(
        'u-1',
        'admin',
        { campus: 'gardanne' },
        {
          requestId: RID,
        }
      );
      expect(post).toHaveBeenCalledWith(
        expect.stringContaining('/internal/notifications/profile-correction'),
        expect.objectContaining({ recipientId: 'u-1', outcome: 'applied', requestId: RID }),
        expect.objectContaining({ headers: { 'X-Internal-Secret': 'internal' } })
      );
    });

    it('CLAIMS the request before authentik is written, and of two admins only one writes', async () => {
      const { service, requests, edit } = make();
      const order: string[] = [];
      requests.update.mockImplementationOnce(async () => {
        order.push('claim');
        return { affected: 1 };
      });
      edit.applyEdit.mockImplementation(async () => {
        order.push('authentik');
        return { user: { id: 'u-1' }, changed: true, changeId: 'c' };
      });
      await service.apply(RID, 'u-1', 'admin', {});
      expect(order).toEqual(['claim', 'authentik']);
      expect(requests.update).toHaveBeenNthCalledWith(
        1,
        { id: RID, status: 'pending' },
        { status: 'applying' }
      );

      // The second admin read `pending` too, but the claim is atomic: it loses, authentik is not touched.
      const second = make();
      second.requests.update.mockResolvedValue({ affected: 0 });
      await expect(second.service.apply(RID, 'u-1', 'admin2', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotPendingError
      );
      expect(second.edit.applyEdit).not.toHaveBeenCalled();
    });

    it('releases the claim when the edit fails, so the request can be retried', async () => {
      const { service, requests, edit } = make();
      edit.applyEdit.mockRejectedValue(new Error('authentik down'));
      await expect(service.apply(RID, 'u-1', 'admin', {})).rejects.toThrow('authentik down');
      expect(requests.update).toHaveBeenLastCalledWith(
        { id: RID, status: 'applying' },
        { status: 'pending' }
      );
    });

    it('a malformed id is the typed NOT_FOUND, never a database error', async () => {
      const { service, requests, edit } = make();
      await expect(service.apply('not-a-uuid', 'u-1', 'admin', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotFoundError
      );
      await expect(service.refuse('x', 'admin', '')).rejects.toBeInstanceOf(
        ProfileCorrectionNotFoundError
      );
      expect(requests.findOne).not.toHaveBeenCalled();
      expect(edit.applyEdit).not.toHaveBeenCalled();
    });

    it('an edit of one person may not close another person request', async () => {
      const { service, edit } = make();
      await expect(service.apply(RID, 'u-OTHER', 'admin', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotFoundError
      );
      expect(edit.applyEdit).not.toHaveBeenCalled();
    });

    it('refuses an answered or unknown request BEFORE authentik is written', async () => {
      const answered = make(pending({ status: 'applied' }));
      await expect(answered.service.apply(RID, 'u-1', 'admin', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotPendingError
      );
      const missing = make(null);
      await expect(missing.service.apply(RID, 'u-1', 'admin', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotFoundError
      );
      expect(answered.edit.applyEdit).not.toHaveBeenCalled();
      expect(missing.edit.applyEdit).not.toHaveBeenCalled();
    });

    it('a notification that cannot be delivered is logged at error and does not undo the answer', async () => {
      const { service } = make();
      post.mockRejectedValue(new Error('social down'));
      await expect(service.apply(RID, 'u-1', 'admin', {})).resolves.toMatchObject({
        changed: true,
      });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('was NOT delivered'));
    });

    it('an edit that fails (dev refusal, authentik down) leaves the request open and tells nobody', async () => {
      const { service, edit } = make();
      edit.applyEdit.mockRejectedValue(new Error('refused'));
      await expect(service.apply(RID, 'u-1', 'admin', {})).rejects.toThrow('refused');
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('refuse', () => {
    it('marks it refused with the note, then tells the person the note', async () => {
      const { service, requests } = make();
      const result = await service.refuse(RID, 'admin', '  not a mistake  ');
      expect(requests.update).toHaveBeenCalledWith(
        { id: RID, status: 'pending' },
        expect.objectContaining({
          status: 'refused',
          resolvedBy: 'admin',
          resolutionNote: 'not a mistake',
        })
      );
      expect(post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ outcome: 'refused', note: 'not a mistake' }),
        expect.anything()
      );
      expect(result.status).toBe('refused');
    });

    it('a request answered in the meantime is refused, and nobody is told twice', async () => {
      const { service, requests } = make();
      requests.update.mockResolvedValue({ affected: 0 });
      await expect(service.refuse(RID, 'admin', '')).rejects.toBeInstanceOf(
        ProfileCorrectionNotPendingError
      );
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('latestFor', () => {
    it('never hands the requester the answering admin id, and an applying claim reads as open', async () => {
      const { service, requests } = make();
      requests.findOne.mockResolvedValue(
        pending({ status: 'applying', resolvedBy: 'admin-secret' })
      );
      const own = await service.latestFor('u-1');
      expect(own).not.toHaveProperty('resolvedBy');
      expect(own).not.toHaveProperty('userId');
      expect(own?.status).toBe('pending');
    });
  });

  describe('listPending', () => {
    it('adds the display name the admin recognises the person by', async () => {
      const { service, requests, users } = make();
      requests.find.mockResolvedValue([pending()]);
      users.find.mockResolvedValue([{ id: 'u-1', displayName: 'Camille D' }]);
      const rows = await service.listPending();
      expect(rows[0]).toMatchObject({ id: RID, displayName: 'Camille D' });
    });

    it('is empty without a second query', async () => {
      const { service, users } = make();
      expect(await service.listPending()).toEqual([]);
      expect(users.find).not.toHaveBeenCalled();
    });
  });
});
