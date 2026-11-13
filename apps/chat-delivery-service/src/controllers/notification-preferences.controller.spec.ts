/// <reference types="jest" />

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { callsAllowedFor } from '../entities/group-member.entity';

describe('NotificationPreferencesController', () => {
  let row: { disabledCategories: string[]; enabledCategories?: string[] } | null;
  let memberRows: Array<{ groupId: string; notifLevel: string; callsAllowed?: boolean | null }>;
  const manager = {
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => memberRows),
    // The PUT's one merge statement: answers what it stored - here the caller's two sets, and no
    // push turned on by a save that did not declare the opt-in reading.
    query: jest.fn(async (_sql: string, params: [string, string, string[], string, boolean]) => [
      {
        disabled: (JSON.parse(params[1]) as string[]).sort(),
        enabled: params[4] ? (JSON.parse(params[3]) as string[]) : [],
      },
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

  it('answers nothing off and no push turned on for an account that never set anything', async () => {
    expect(await controller.get('u1')).toEqual({
      disabled: [],
      enabled: [],
      groupLevels: {},
      groupCalls: {},
    });
  });

  it('answers what was stored, dropping an id the server no longer knows', async () => {
    row = { disabledCategories: ['posts', 'retired_category'], enabledCategories: ['posts'] };
    expect(await controller.get('u1')).toEqual({
      disabled: ['posts'],
      // Only an opt-in category can have its push turned on.
      enabled: [],
      groupLevels: {},
      groupCalls: {},
    });
  });

  it('answers the two switches of Suggestions as stored ("Deux niveaux", owner 2026-11-11)', async () => {
    row = { disabledCategories: ['posts'], enabledCategories: ['suggestions'] };
    expect(await controller.get('u1')).toMatchObject({
      disabled: ['posts'],
      enabled: ['suggestions'],
    });
    // The alpha.1 switch turned off: off in the app, and so never pushed.
    row = { disabledCategories: ['suggestions'], enabledCategories: [] };
    expect(await controller.get('u1')).toMatchObject({ disabled: ['suggestions'], enabled: [] });
  });

  /** The parameters of the one merge statement: the caller, its set, the kept ones, the pushes on, declared. */
  const merged = () =>
    manager.query.mock.calls[0][1] as [string, string, string[], string, boolean];

  it('stores the disabled set once per id, keyed by the caller, and answers what is stored', async () => {
    const r = await controller.put(
      'u1',
      { disabled: ['posts', 'posts', 'forms'], enabled: ['suggestions'] },
      '1.6.10'
    );
    expect(r).toEqual({ disabled: ['posts', 'forms'], enabled: ['suggestions'] });
    expect(merged()).toEqual(['u1', '["forms","posts"]', [], '["suggestions"]', true]);
  });

  it('a save without the enabled field never turns a push on, whatever its build (P3, 1.6.10-alpha.1)', async () => {
    const r = await controller.put('u1', { disabled: [] }, '1.6.10-alpha.1');
    expect(merged()[4]).toBe(false);
    expect(merged()[3]).toBe('[]');
    expect(r.enabled).toEqual([]);
  });

  it('a declared save with the push left off writes it off', async () => {
    await controller.put('u1', { disabled: [], enabled: [] }, '1.6.10');
    expect(merged()[3]).toBe('[]');
    expect(merged()[4]).toBe(true);
  });

  it('refuses a non-opt-in id, or a value that is not an array, in enabled', async () => {
    await expect(
      controller.put('u1', { disabled: [], enabled: ['posts'] }, '1.6.10')
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.put('u1', { disabled: [], enabled: 'suggestions' }, '1.6.10')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('keeps the stored choice for every category a headerless build (up to 1.6.9) cannot name', async () => {
    await controller.put('u1', { disabled: ['posts'], enabled: ['suggestions'] });
    expect(merged()[2]).toEqual(['suggestions']);
    // It cannot turn the push on: it never drew the switch.
    expect(merged()[3]).toEqual('[]');
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
