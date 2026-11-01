import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LYDIA_PAYMENTS_ACTIVE_TYPE,
  LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED,
  LYDIA_PAYMENTS_PAUSED_TYPE,
  LydiaPaymentsNotifier,
} from './lydia-payments-notifier.service';

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
    'utf8'
  )
) as { notificationTypes: { active: string; paused: string } };

describe('LydiaPaymentsNotifier', () => {
  const asso = { id: 'asso-12345678', name: 'BDE' };

  const holders = ['u1', 'u2'];

  function make() {
    const notifications = {
      createNotifications: jest.fn(async (d: { recipientIds: string[] }) => d.recipientIds.length),
    };
    const push = { notifyContent: jest.fn(async () => undefined) };
    const service = new LydiaPaymentsNotifier(notifications as any, push as any);
    return { service, notifications, push };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('names the types the shared contract names', () => {
    expect(LYDIA_PAYMENTS_ACTIVE_TYPE).toBe(CONTRACT.notificationTypes.active);
    expect(LYDIA_PAYMENTS_PAUSED_TYPE).toBe(CONTRACT.notificationTypes.paused);
  });

  // The gate is a deliberate pull request, not a forgotten constant: this fails the day it flips,
  // and that pull request must say the floor covers Lydia enrolment lot 2 on both estates.
  it('ships switched off, until minClientVersion covers the release carrying lot 2', () => {
    expect(LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED).toBe(false);
    expect(make().service.enabled()).toBe(false);
  });

  it('writes nothing and pushes nothing while switched off', async () => {
    const { service, notifications, push } = make();
    await expect(service.tell(asso, 'active', holders)).resolves.toBe(0);
    await flush();
    expect(notifications.createNotifications).not.toHaveBeenCalled();
    expect(push.notifyContent).not.toHaveBeenCalled();
  });

  describe('switched on', () => {
    it('tells the recipients it is given, the association id and name on the row', async () => {
      const { service, notifications, push } = make();
      jest.spyOn(service, 'enabled').mockReturnValue(true);
      await expect(service.tell(asso, 'paused', holders)).resolves.toBe(2);
      await flush();
      expect(notifications.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientIds: ['u1', 'u2'],
          type: 'lydia_payments_paused',
          postId: asso.id,
          text: 'BDE',
          skipPush: true,
        })
      );
      expect(push.notifyContent).toHaveBeenCalledTimes(2);
    });

    it('uses the active type for an activation', async () => {
      const { service, notifications } = make();
      jest.spyOn(service, 'enabled').mockReturnValue(true);
      await service.tell(asso, 'active', holders);
      expect(notifications.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'lydia_payments_active' })
      );
    });

    it('logs a push failure and does not throw', async () => {
      const { service, push } = make();
      jest.spyOn(service, 'enabled').mockReturnValue(true);
      push.notifyContent.mockRejectedValue(new Error('fcm down'));
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      await expect(service.tell(asso, 'active', holders)).resolves.toBe(2);
      await flush();
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('throws when the insert throws', async () => {
      const { service, notifications } = make();
      jest.spyOn(service, 'enabled').mockReturnValue(true);
      notifications.createNotifications.mockRejectedValue(new Error('db down'));
      await expect(service.tell(asso, 'active', holders)).rejects.toThrow('db down');
    });
  });
});
