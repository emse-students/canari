/// <reference types="jest" />

import { BadRequestException, Logger } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  HelpSeenController,
  HELP_ID_UNKNOWN,
  HELP_SEEN_LIMIT_PER_MINUTE,
} from './help-seen.controller';
import { HelpSeenService } from './help-seen.service';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AccountThrottlerGuard } from '../common/guards/account-throttler.guard';

/**
 * The two routes of the seen-help store: the allowlist is checked BEFORE anything is written, both
 * routes are guarded and throttled per account, and the path cannot be captured by `users/:id`.
 */
describe('HelpSeenController', () => {
  const service = {
    seenBy: jest.fn(async () => ['welcome-tour']),
    markSeen: jest.fn(async () => undefined),
  };
  const controller = new HelpSeenController(service as unknown as HelpSeenService);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('answers the seen set in an envelope, for the lower-cased caller', async () => {
    await expect(controller.list(' ABC-User ')).resolves.toEqual({ seen: ['welcome-tour'] });
    expect(service.seenBy).toHaveBeenCalledWith('abc-user');
  });

  it('records a listed id', async () => {
    await expect(controller.markSeen('u1', 'welcome-tour')).resolves.toEqual({ success: true });
    expect(service.markSeen).toHaveBeenCalledWith('u1', 'welcome-tour');
  });

  it('refuses an id outside the allowlist with a typed code, and writes nothing', async () => {
    for (const junk of ['nope', 'WELCOME-TOUR', '', 'welcome-tour/../x', 'x'.repeat(5000)]) {
      await expect(controller.markSeen('u1', junk)).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: HELP_ID_UNKNOWN },
      });
    }
    expect(service.markSeen).not.toHaveBeenCalled();
  });

  it('guards and throttles both routes per account', () => {
    // The handlers are read as metadata targets by NAME, never called, so no `this` is lost.
    for (const name of ['list', 'markSeen'] as const) {
      const handler = Object.getOwnPropertyDescriptor(HelpSeenController.prototype, name)!.value;
      const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
      expect(guards).toEqual([NginxAuthGuard, AccountThrottlerGuard]);
      // @nestjs/throttler stores the limit per throttler name under `THROTTLER:LIMIT<name>`.
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
        HELP_SEEN_LIMIT_PER_MINUTE
      );
    }
  });

  it('sits three segments deep, where the users catch-all cannot capture it', () => {
    const segments = String(Reflect.getMetadata(PATH_METADATA, HelpSeenController))
      .split('/')
      .filter(Boolean);
    expect(segments).toEqual(['users', 'me', 'help-seen']);
  });
});
