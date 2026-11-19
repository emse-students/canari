import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalProfileNotificationsController } from './internal-profile-notifications.controller';
import type { PostNotificationsService } from '../posts/post-notifications.service';
import type { AdminQueuesService } from '../admin-queues/admin-queues.service';

describe('InternalProfileNotificationsController', () => {
  const env = { ...process.env };
  const createNotification = jest.fn().mockResolvedValue(undefined);
  const announceProfileCorrection = jest.fn().mockResolvedValue(2);
  const queueChanged = jest.fn().mockResolvedValue(undefined);
  const controller = new InternalProfileNotificationsController(
    { createNotification } as unknown as PostNotificationsService,
    { announceProfileCorrection, queueChanged } as unknown as AdminQueuesService
  );

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    createNotification.mockClear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  const body = { recipientId: 'u-1', outcome: 'applied' as const, requestId: 'req-1' };

  it('writes an in-app notification as the platform, with NO system push', async () => {
    await controller.profileCorrection('shared-secret', body);
    expect(createNotification).toHaveBeenCalledWith({
      recipientId: 'u-1',
      type: 'profile_correction_applied',
      postId: 'req-1',
      actorId: '',
      actorName: 'Canari',
      text: '',
      skipPush: true,
    });
    // The request left the queue: the global admins' badges recount.
    expect(queueChanged).toHaveBeenCalledWith({ queue: 'profile-corrections' });
  });

  it('carries a refusal note, bounded', async () => {
    await controller.profileCorrection('shared-secret', {
      ...body,
      outcome: 'refused',
      note: 'x'.repeat(900),
    });
    const call = createNotification.mock.calls[0][0] as { type: string; text: string };
    expect(call.type).toBe('profile_correction_refused');
    expect(call.text).toHaveLength(500);
  });

  it('refuses a caller without the internal secret', async () => {
    await expect(controller.profileCorrection('wrong', body)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('refuses an unknown outcome or a missing id rather than writing a row of an invented type', async () => {
    await expect(
      controller.profileCorrection('shared-secret', { ...body, outcome: 'vanished' as never })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.profileCorrection('shared-secret', { ...body, requestId: '' })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createNotification).not.toHaveBeenCalled();
  });

  describe('a request FILED (owner, 2026-11-18)', () => {
    const filed = { requestId: 'req-9', requesterId: 'u-7' };

    it('hands it to the admin queues, which tell every global admin', async () => {
      announceProfileCorrection.mockClear();
      await expect(controller.profileCorrectionFiled('shared-secret', filed)).resolves.toEqual({
        told: 2,
      });
      expect(announceProfileCorrection).toHaveBeenCalledWith('req-9', 'u-7');
    });

    it('refuses a caller without the internal secret, and a malformed body', async () => {
      announceProfileCorrection.mockClear();
      await expect(controller.profileCorrectionFiled('wrong', filed)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(
        controller.profileCorrectionFiled('shared-secret', { requestId: 'req-9' })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(announceProfileCorrection).not.toHaveBeenCalled();
    });
  });
});
