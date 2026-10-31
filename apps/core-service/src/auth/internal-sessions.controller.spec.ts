/// <reference types="jest" />

import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalSessionsController } from './internal-sessions.controller';
import type { AuthSessionsService } from './auth-sessions.service';

const SECRET = 'internal-secret-for-tests';
const CALLER = '0A0A0A0A-0000-4000-8000-0000000000A1';

/**
 * The route chat-delivery calls once an owner's device ban is recorded: gated on the internal
 * secret, and it validates every name before any session is touched.
 */
describe('InternalSessionsController', () => {
  let endDeviceSessions: jest.Mock;
  let controller: InternalSessionsController;
  const previous = process.env.INTERNAL_SECRET;

  beforeAll(() => {
    process.env.INTERNAL_SECRET = SECRET;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previous;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    endDeviceSessions = jest.fn().mockResolvedValue(2);
    controller = new InternalSessionsController({
      endDeviceSessions,
    } as unknown as AuthSessionsService);
  });

  it("ends the device's sessions except the caller's, and says how many", async () => {
    await expect(
      controller.endDeviceSessions('user-1', 'phone-1', CALLER, SECRET)
    ).resolves.toEqual({ ended: 2 });
    expect(endDeviceSessions).toHaveBeenCalledWith('user-1', 'phone-1', CALLER.toLowerCase());
  });

  it('ends them all when the caller names no session', async () => {
    await controller.endDeviceSessions('user-1', 'phone-1', undefined, SECRET);
    expect(endDeviceSessions).toHaveBeenCalledWith('user-1', 'phone-1', null);
  });

  it('refuses a caller without the internal secret, before anything', async () => {
    await expect(
      controller.endDeviceSessions('user-1', 'phone-1', undefined, 'wrong')
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.endDeviceSessions('user-1', 'phone-1', undefined, undefined)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(endDeviceSessions).not.toHaveBeenCalled();
  });

  it('refuses a malformed device id or caller session rather than guessing', async () => {
    await expect(
      controller.endDeviceSessions('user-1', 'phone 1;--', undefined, SECRET)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.endDeviceSessions('user-1', 'phone-1', 'not-a-uuid', SECRET)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.endDeviceSessions('', 'phone-1', undefined, SECRET)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(endDeviceSessions).not.toHaveBeenCalled();
  });
});
