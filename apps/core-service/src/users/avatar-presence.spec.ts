/// <reference types="jest" />

import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AvatarService } from './avatar.service';
import { UsersController } from './users.controller';
import type { UsersService } from './users.service';
import type { UserBlocksService } from './user-blocks.service';
import type { ProfileEditService } from './profile-edit.service';
import type { ProfileCorrectionService } from './profile-correction.service';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';

// Nothing here may leave the machine (see `avatar.service.spec.ts`).
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * `GET /users/avatar-presence`: which members have a photo, asked of the gallery once per list.
 *
 * Mi 9T, 2026-10-13: a salon open asked every member's avatar and learned "no photo" by being
 * refused - 37 `404`s in one walk, each a console error line. Three answers matter, and each is a
 * different instruction to the client: a list (request only those faces), an empty list on an
 * estate with no gallery (request none), and `null` when the gallery could not say (request each,
 * as before - never "nobody has a photo").
 */
describe('avatar presence', () => {
  function service(key = 'k'): AvatarService {
    const config = {
      get: (name: string, fallback?: string) =>
        name === 'MIGALLERY_API_KEY' ? key : (fallback ?? ''),
    } as unknown as ConfigService;
    return new AvatarService(config);
  }

  function controller(avatars: AvatarService): UsersController {
    return new UsersController(
      {} as UsersService,
      avatars,
      {} as UserBlocksService,
      {} as ProfileEditService,
      {} as ProfileCorrectionService,
      {} as AccountErasureService,
      {} as never // AuthSessionsService: no admin flag route here
    );
  }

  beforeEach(() => {
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => !!e && typeof e === 'object' && 'isAxiosError' in e
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('asks the gallery ONCE for the whole list and answers in the order asked', async () => {
    mockedAxios.get.mockResolvedValue({ data: { withPhoto: ['c', 'a'] } });

    const answer = await controller(service()).avatarPresence('a,b,c,a');

    expect(mockedAxios.get.mock.calls).toHaveLength(1);
    expect(mockedAxios.get.mock.calls[0][1]?.params).toEqual({ ids: 'a,b,c' });
    expect(answer).toEqual({ withPhoto: ['a', 'c'] });
  });

  it('answers an empty list, without asking anybody, on an estate with no gallery', async () => {
    // The constructor's one startup warning is the estate's, and expected here.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const answer = await controller(service('')).avatarPresence('a,b');

    expect(mockedAxios.get.mock.calls).toHaveLength(0);
    expect(answer).toEqual({ withPhoto: [] });
  });

  it('answers null - not "nobody has a photo" - when the gallery cannot say', async () => {
    // An older gallery without the route answers 404; an outage throws without a status.
    mockedAxios.get.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404 },
      message: 'Not Found',
    });
    mockedAxios.get.mockRejectedValueOnce({
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout',
    });
    const avatars = service();
    const logged = jest
      .spyOn((avatars as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    expect(await controller(avatars).avatarPresence('a')).toEqual({ withPhoto: null });
    expect(await controller(avatars).avatarPresence('a')).toEqual({ withPhoto: null });
    expect(logged).toHaveBeenCalledTimes(2);
    expect(String(logged.mock.calls[0][0])).toContain('clients will ask each avatar');
  });

  it('refuses a list longer than the profile batch rather than answering part of it', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `u${String(i)}`).join(',');

    await expect(controller(service()).avatarPresence(ids)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(mockedAxios.get.mock.calls).toHaveLength(0);
  });

  it('refuses an id the avatar route would refuse, since the list is forwarded', async () => {
    await expect(controller(service()).avatarPresence('a,../admin')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(mockedAxios.get.mock.calls).toHaveLength(0);
  });
});
