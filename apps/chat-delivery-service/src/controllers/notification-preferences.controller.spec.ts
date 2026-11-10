/// <reference types="jest" />

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { callsAllowedFor } from '../entities/group-member.entity';

describe('NotificationPreferencesController', () => {
  let row: { disabledCategories: string[] } | null;
  let memberRows: Array<{ groupId: string; notifLevel: string; callsAllowed?: boolean | null }>;
  const manager = {
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => memberRows),
    // The PUT's one merge statement: answers what it stored, here the caller's set sorted.
    query: jest.fn(async (_sql: string, params: [string, string, string[]]) => [
      { disabled: (JSON.parse(params[1]) as string[]).sort() },
    ]),
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
    expect(await controller.get('u1')).toEqual({ disabled: [], groupLevels: {}, groupCalls: {} });
  });

  it('answers what was stored, dropping an id the server no longer knows', async () => {
    row = { disabledCategories: ['posts', 'retired_category'] };
    expect(await controller.get('u1')).toEqual({
      disabled: ['posts'],
      groupLevels: {},
      groupCalls: {},
    });
  });

  /** The parameters of the one merge statement: the caller, its set, the categories kept. */
  const merged = () => manager.query.mock.calls[0][1] as [string, string, string[]];

  it('stores the disabled set once per id, keyed by the caller, and answers what is stored', async () => {
    const r = await controller.put('u1', { disabled: ['posts', 'posts', 'forms'] }, '1.6.10');
    expect(r).toEqual({ disabled: ['forms', 'posts'] });
    expect(merged()).toEqual(['u1', '["forms","posts"]', []]);
  });

  it('keeps the stored choice for every category a headerless build (up to 1.6.9) cannot name', async () => {
    await controller.put('u1', { disabled: ['posts'] });
    expect(merged()[2]).toEqual(['suggestions']);
  });

  it('keeps what a 1.6.8 build draws no switch for: birthdays and suggestions', async () => {
    await controller.put('u1', { disabled: [] }, '1.6.8');
    expect(merged()[2]).toEqual(['birthdays', 'suggestions']);
  });

  it('a pre-release of 1.6.10 names suggestions; an unreadable build names only the oldest set', async () => {
    await controller.put('u1', { disabled: [] }, '1.6.10-alpha.1');
    expect(merged()[2]).toEqual([]);
    manager.query.mockClear();
    await controller.put('u1', { disabled: [] }, 'latest');
    expect(merged()[2]).toEqual(['follows', 'bookings', 'birthdays', 'suggestions']);
  });

  it('refuses an unknown category rather than reporting it saved', async () => {
    await expect(controller.put('u1', { disabled: ['posts', 'calls'] })).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(manager.query).not.toHaveBeenCalled();
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

  describe("a private conversation's call permission", () => {
    const g = '0b9f3d7e-1111-4222-8333-444455556666';

    it('lists only the explicit choices - a member who never chose is absent', async () => {
      memberRows = [
        { groupId: 'g-unset', notifLevel: 'none', callsAllowed: null },
        { groupId: 'g-yes', notifLevel: 'none', callsAllowed: true },
        { groupId: 'g-no', notifLevel: 'all', callsAllowed: false },
      ];
      expect((await controller.get('u1')).groupCalls).toEqual({ 'g-yes': true, 'g-no': false });
    });

    it("writes the choice on the caller's own membership row", async () => {
      expect(await controller.setGroupCalls('u1', g, { allowed: false })).toEqual({
        groupId: g,
        allowed: false,
      });
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { groupId: g, userId: 'u1' },
        { callsAllowed: false }
      );
    });

    it('refuses a non-member rather than reporting it saved', async () => {
      manager.update.mockResolvedValueOnce({ affected: 0 });
      await expect(controller.setGroupCalls('u1', g, { allowed: true })).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('refuses a value that is not a boolean and a group id that is not a uuid', async () => {
      await expect(controller.setGroupCalls('u1', g, { allowed: 'yes' })).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(
        controller.setGroupCalls('u1', 'not-a-uuid', { allowed: true })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});

describe('callsAllowedFor - THE rule the ring fan-out applies', () => {
  it('an explicit choice wins over the level, both ways', () => {
    expect(callsAllowedFor('none', true)).toBe(true);
    expect(callsAllowedFor('all', false)).toBe(false);
  });

  it('a member who never chose is rung unless the conversation is at none', () => {
    expect(callsAllowedFor('all', null)).toBe(true);
    expect(callsAllowedFor('mentions', null)).toBe(true);
    expect(callsAllowedFor('none', null)).toBe(false);
    // A row read before migration 032 has no such field at all.
    expect(callsAllowedFor(undefined, undefined)).toBe(true);
  });
});
