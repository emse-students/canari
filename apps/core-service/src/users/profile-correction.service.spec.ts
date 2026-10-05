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

const pending = (over: Partial<ProfileCorrectionRequest> = {}) =>
  ({
    id: 'req-1',
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
      await service.apply('req-1', 'u-1', 'admin', { campus: 'gardanne' });
      expect(edit.applyEdit).toHaveBeenCalledWith(
        'u-1',
        'admin',
        { campus: 'gardanne' },
        {
          requestId: 'req-1',
        }
      );
      expect(post).toHaveBeenCalledWith(
        expect.stringContaining('/internal/notifications/profile-correction'),
        expect.objectContaining({ recipientId: 'u-1', outcome: 'applied', requestId: 'req-1' }),
        expect.objectContaining({ headers: { 'X-Internal-Secret': 'internal' } })
      );
    });

    it('an edit of one person may not close another person request', async () => {
      const { service, edit } = make();
      await expect(service.apply('req-1', 'u-OTHER', 'admin', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotFoundError
      );
      expect(edit.applyEdit).not.toHaveBeenCalled();
    });

    it('refuses an answered or unknown request BEFORE authentik is written', async () => {
      const answered = make(pending({ status: 'applied' }));
      await expect(answered.service.apply('req-1', 'u-1', 'admin', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotPendingError
      );
      const missing = make(null);
      await expect(missing.service.apply('req-1', 'u-1', 'admin', {})).rejects.toBeInstanceOf(
        ProfileCorrectionNotFoundError
      );
      expect(answered.edit.applyEdit).not.toHaveBeenCalled();
      expect(missing.edit.applyEdit).not.toHaveBeenCalled();
    });

    it('a notification that cannot be delivered is logged at error and does not undo the answer', async () => {
      const { service } = make();
      post.mockRejectedValue(new Error('social down'));
      await expect(service.apply('req-1', 'u-1', 'admin', {})).resolves.toMatchObject({
        changed: true,
      });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('was NOT delivered'));
    });

    it('an edit that fails (dev refusal, authentik down) leaves the request open and tells nobody', async () => {
      const { service, edit } = make();
      edit.applyEdit.mockRejectedValue(new Error('refused'));
      await expect(service.apply('req-1', 'u-1', 'admin', {})).rejects.toThrow('refused');
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('refuse', () => {
    it('marks it refused with the note, then tells the person the note', async () => {
      const { service, requests } = make();
      const result = await service.refuse('req-1', 'admin', '  not a mistake  ');
      expect(requests.update).toHaveBeenCalledWith(
        { id: 'req-1', status: 'pending' },
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
      await expect(service.refuse('req-1', 'admin', '')).rejects.toBeInstanceOf(
        ProfileCorrectionNotPendingError
      );
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('listPending', () => {
    it('adds the display name the admin recognises the person by', async () => {
      const { service, requests, users } = make();
      requests.find.mockResolvedValue([pending()]);
      users.find.mockResolvedValue([{ id: 'u-1', displayName: 'Camille D' }]);
      const rows = await service.listPending();
      expect(rows[0]).toMatchObject({ id: 'req-1', displayName: 'Camille D' });
    });

    it('is empty without a second query', async () => {
      const { service, users } = make();
      expect(await service.listPending()).toEqual([]);
      expect(users.find).not.toHaveBeenCalled();
    });
  });
});
