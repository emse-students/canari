/// <reference types="jest" />

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NotificationPreferencesController } from './notification-preferences.controller';

describe('NotificationPreferencesController', () => {
  let row: { disabledCategories: string[] } | null;
  let memberRows: Array<{ groupId: string; notifLevel: string }>;
  const manager = {
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => memberRows),
    upsert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  let controller: NotificationPreferencesController;

  beforeEach(() => {
    jest.clearAllMocks();
    row = null;
    memberRows = [];
    controller = new NotificationPreferencesController({
      manager,
    } as unknown as ConstructorParameters<typeof NotificationPreferencesController>[0]);
  });

  it('answers an empty set - everything on - for an account that never set anything', async () => {
    expect(await controller.get('u1')).toEqual({ disabled: [], groupLevels: {} });
  });

  it('answers what was stored, dropping an id the server no longer knows', async () => {
    row = { disabledCategories: ['posts', 'retired_category'] };
    expect(await controller.get('u1')).toEqual({ disabled: ['posts'], groupLevels: {} });
  });

  it('stores the disabled set once per id, keyed by the caller', async () => {
    const r = await controller.put('u1', { disabled: ['posts', 'posts', 'forms'] });
    expect(r).toEqual({ disabled: ['posts', 'forms'] });
    expect(manager.upsert).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'u1', disabledCategories: ['posts', 'forms'] },
      { conflictPaths: ['userId'] }
    );
  });

  it('refuses an unknown category rather than reporting it saved', async () => {
    await expect(controller.put('u1', { disabled: ['posts', 'calls'] })).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(manager.upsert).not.toHaveBeenCalled();
  });

  it('refuses a body that is not an array', async () => {
    await expect(controller.put('u1', { disabled: 'posts' })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  describe('a private conversation level', () => {
    const g = '0b9f3d7e-1111-4222-8333-444455556666';

    it('lists only the conversations quieter than all', async () => {
      memberRows = [
        { groupId: 'g-all', notifLevel: 'all' },
        { groupId: 'g-m', notifLevel: 'mentions' },
        { groupId: 'g-n', notifLevel: 'none' },
      ];
      expect((await controller.get('u1')).groupLevels).toEqual({
        'g-m': 'mentions',
        'g-n': 'none',
      });
    });

    it("writes the level on the caller's own membership row", async () => {
      expect(await controller.setGroupLevel('u1', g, { level: 'mentions' })).toEqual({
        groupId: g,
        level: 'mentions',
      });
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { groupId: g, userId: 'u1' },
        { notifLevel: 'mentions' }
      );
    });

    it('refuses a non-member rather than reporting it saved', async () => {
      manager.update.mockResolvedValueOnce({ affected: 0 });
      await expect(controller.setGroupLevel('u1', g, { level: 'none' })).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('refuses an unknown level and a group id that is not a uuid', async () => {
      await expect(controller.setGroupLevel('u1', g, { level: 'mute' })).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(
        controller.setGroupLevel('u1', 'not-a-uuid', { level: 'none' })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
