/// <reference types="jest" />

import { BadRequestException } from '@nestjs/common';
import { NotificationPreferencesController } from './notification-preferences.controller';

describe('NotificationPreferencesController', () => {
  let row: { disabledCategories: string[] } | null;
  const manager = {
    findOne: jest.fn(async () => row),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  let controller: NotificationPreferencesController;

  beforeEach(() => {
    jest.clearAllMocks();
    row = null;
    controller = new NotificationPreferencesController({
      manager,
    } as unknown as ConstructorParameters<typeof NotificationPreferencesController>[0]);
  });

  it('answers an empty set - everything on - for an account that never set anything', async () => {
    expect(await controller.get('u1')).toEqual({ disabled: [] });
  });

  it('answers what was stored, dropping an id the server no longer knows', async () => {
    row = { disabledCategories: ['posts', 'retired_category'] };
    expect(await controller.get('u1')).toEqual({ disabled: ['posts'] });
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
});
