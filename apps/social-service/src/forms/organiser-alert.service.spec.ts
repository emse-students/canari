import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import {
  FORM_ORGANISER_ALERT_ENABLED,
  FORM_PAID_OVER_CAPACITY_TYPE,
  FormOrganiserAlertService,
} from './organiser-alert.service';

/**
 * WHO the organiser alert tells and WHAT it says. The AT MOST ONCE around it is `markPaid`'s, in
 * `forms.service.seat-hold.spec.ts`; the same against a real database is
 * `organiser-alert.integration.spec.ts`.
 */
describe('FormOrganiserAlertService', () => {
  function make(holders: string[] = []) {
    const associationsService = { listFlagHolders: jest.fn(async () => holders) };
    const notifications = {
      createNotifications: jest.fn(async (d: { recipientIds: string[] }) => d.recipientIds.length),
    };
    const push = { notifyContent: jest.fn(async () => undefined) };
    const service = new FormOrganiserAlertService(
      associationsService as any,
      notifications as any,
      push as any
    );
    return { service, associationsService, notifications, push };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // The gate is a deliberate pull request, not a forgotten constant: this fails the day it flips,
  // and that pull request must say the floor covers #1911 on both estates.
  it('ships switched off, until minClientVersion covers the unknown-type fix (#1911)', () => {
    expect(FORM_ORGANISER_ALERT_ENABLED).toBe(false);
    expect(make().service.enabled()).toBe(false);
  });

  it("tells a personal form's owner alone, and asks no association", async () => {
    const { service, associationsService, notifications } = make();
    await service.tell({ id: 'f1', title: 'Gala', ownerId: 'owner', associationId: null as any });
    expect(associationsService.listFlagHolders).not.toHaveBeenCalled();
    expect(notifications.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ recipientIds: ['owner'] })
    );
  });

  it("tells the owner and the association's MANAGE_FORMS holders, each once", async () => {
    const { service, associationsService, notifications } = make(['m1', 'owner', 'm2']);
    await service.tell({ id: 'f1', title: 'Gala', ownerId: 'owner', associationId: 'a1' });
    expect(associationsService.listFlagHolders).toHaveBeenCalledWith(
      'a1',
      AssociationPermissionFlag.MANAGE_FORMS
    );
    expect(notifications.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ recipientIds: ['owner', 'm1', 'm2'] })
    );
  });

  it('writes a row naming the form by its title only, with no person as its actor', async () => {
    const { service, notifications } = make();
    await service.tell({ id: 'f1', title: 'Gala', ownerId: 'owner', associationId: null as any });
    expect(notifications.createNotifications).toHaveBeenCalledWith({
      recipientIds: ['owner'],
      type: FORM_PAID_OVER_CAPACITY_TYPE,
      postId: 'f1',
      actorId: 'system',
      actorName: 'Canari',
      text: 'Gala',
      skipPush: true,
    });
  });

  it("pushes the title only, opening that form's responses", async () => {
    const { service, push } = make(['m1']);
    await service.tell({ id: 'f1', title: 'Gala', ownerId: 'owner', associationId: 'a1' });
    await flush();
    expect(push.notifyContent).toHaveBeenCalledTimes(2);
    for (const [, content, data] of push.notifyContent.mock.calls as unknown as [
      string,
      { key: string; arg: string; actorName: string; icon?: unknown },
      Record<string, string>,
    ][]) {
      expect(content).toMatchObject({ key: 'form_paid_over_capacity', arg: 'Gala', actorName: '' });
      expect(content.icon).toBeUndefined();
      expect(data).toEqual({ type: 'social', target: 'form-responses', formId: 'f1' });
    }
  });

  // The caller releases its claim on a throw: a lost row must not be marked as told.
  it('throws when the rows could not be written, and pushes nothing', async () => {
    const { service, notifications, push } = make();
    notifications.createNotifications.mockRejectedValueOnce(new Error('insert failed'));
    await expect(
      service.tell({ id: 'f1', title: 'Gala', ownerId: 'owner', associationId: null as any })
    ).rejects.toThrow('insert failed');
    await flush();
    expect(push.notifyContent).not.toHaveBeenCalled();
  });

  it('logs a failed push per recipient and does not throw', async () => {
    const { service, push } = make(['m1']);
    push.notifyContent.mockRejectedValueOnce(new Error('delivery down'));
    const warn = jest.spyOn((service as any).logger, 'warn');
    await service.tell({ id: 'f1', title: 'Gala', ownerId: 'owner', associationId: 'a1' });
    await flush();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('delivery down'));
  });
});
