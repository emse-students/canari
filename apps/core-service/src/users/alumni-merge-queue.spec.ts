import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { DataSource } from 'typeorm';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import { AlumniMergeService, COMPLETE_MERGE_SQL, autoMergeRefusal } from './alumni-merge.service';
import type { AlumniDuplicateQueue } from './alumni-duplicate-queue.service';
import type { MiconnectEditorClient, MiconnectUserListing } from './miconnect-editor.client';

jest.mock('axios');

const DUP_UUID = '11111111-1111-4111-8111-111111111111';
const TARGET_UUID = '22222222-2222-4222-8222-222222222222';

const person = (over: Partial<MiconnectUserListing>): MiconnectUserListing => ({
  pk: 1,
  uuid: DUP_UUID,
  username: 'alumni-0001',
  name: 'Camille Durand',
  type: 'internal',
  email: 'camille@example.org',
  is_active: true,
  last_login: null,
  attributes: { profile: { cursus: [{ formation: 'ICM', promo: 2020 }] } },
  ...over,
});
const DUP = person({});
const TARGET = person({ pk: 2, uuid: TARGET_UUID, username: 'camille.durand' });

/**
 * What the Alumni duplicates' admin queue is TOLD by the merge service (the SQL of what is pending
 * is proved in social-service's `bell-target-rows.integration.spec`): a duplicate found at the sign-in
 * that creates its account, and the badges recounted when a merge of it is marked or cancelled.
 */
describe('AlumniMergeService and the admin queue', () => {
  let queue: { flag: jest.Mock; changed: jest.Mock };
  let error: jest.SpyInstance;
  const env = { ...process.env };

  beforeEach(() => {
    queue = { flag: jest.fn(async () => undefined), changed: jest.fn(async () => undefined) };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    delete process.env.DEPLOY_BUILD;
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  function make(accounts: MiconnectUserListing[], query: jest.Mock = jest.fn(async () => [])) {
    const editor = {
      assertAvailable: jest.fn(),
      userByUuid: jest.fn(async (uuid: string) => accounts.find((a) => a.uuid === uuid) ?? null),
      searchUsers: jest.fn(async () => accounts),
      // The Alumni-created account holds the Alumni link only; the others hold the CAS's.
      sourceSlugsOf: jest.fn(async (pk: number) => {
        const a = accounts.find((x) => x.pk === pk);
        return a?.username.startsWith('alumni-') ? ['alumni'] : ['cas-emse'];
      }),
      writeUser: jest.fn(async () => undefined),
    };
    const service = new AlumniMergeService(
      { query } as unknown as DataSource,
      editor as unknown as MiconnectEditorClient,
      {} as AccountErasureService
    );
    Object.assign(service, { queue: queue as unknown as AlumniDuplicateQueue });
    return { service, editor, query };
  }

  describe('a new Canari account (flagNewAccount)', () => {
    it('flags an Alumni-created account that matches an existing one - the admins are told at its creation', async () => {
      const { service } = make([DUP, TARGET]);
      await service.flagNewAccount(DUP_UUID);
      expect(queue.flag).toHaveBeenCalledWith(DUP_UUID);
    });

    it('NEVER flags a homonym: two accounts match, so there is no action for the admins yet', async () => {
      const homonym = person({
        pk: 3,
        uuid: '44444444-4444-4444-8444-444444444444',
        username: 'camille.durand2',
      });
      const { service } = make([DUP, TARGET, homonym]);
      await service.flagNewAccount(DUP_UUID);
      expect(queue.flag).not.toHaveBeenCalled();
    });

    it('never flags a duplicate whose links are not exactly [alumni], nor one whose match holds an Alumni link', async () => {
      const { service, editor } = make([DUP, TARGET]);
      editor.sourceSlugsOf.mockImplementation(async (pk: number) =>
        pk === 1 ? ['alumni', 'cas-emse'] : ['cas-emse']
      );
      await service.flagNewAccount(DUP_UUID);
      editor.sourceSlugsOf.mockImplementation(async (pk: number) =>
        pk === 1 ? ['alumni'] : ['alumni']
      );
      await service.flagNewAccount(DUP_UUID);
      expect(queue.flag).not.toHaveBeenCalled();
    });

    it('flags nothing for an account no Alumni sign-in created, and does not even look for a match', async () => {
      const { service, editor } = make([TARGET]);
      await service.flagNewAccount(TARGET_UUID);
      expect(queue.flag).not.toHaveBeenCalled();
      expect(editor.searchUsers).not.toHaveBeenCalled();
    });

    it('flags nothing for an Alumni account that matches nobody: it waits for no admin', async () => {
      const { service } = make([DUP]);
      await service.flagNewAccount(DUP_UUID);
      expect(queue.flag).not.toHaveBeenCalled();
    });

    it('reads nothing on the dev estate, which shares production MiConnect and tells production nothing', async () => {
      process.env.DEPLOY_BUILD = 'dev-build';
      const { service, editor } = make([DUP, TARGET]);
      await service.flagNewAccount(DUP_UUID);
      expect(editor.userByUuid).not.toHaveBeenCalled();
      expect(queue.flag).not.toHaveBeenCalled();
    });

    it('never throws: a failed read is said at error, the page reading finds the duplicate later', async () => {
      const { service, editor } = make([DUP, TARGET]);
      editor.userByUuid.mockRejectedValueOnce(new Error('authentik down'));
      await expect(service.flagNewAccount(DUP_UUID)).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT checked for a duplicate'));
    });
  });

  it('closing a completed merge resolves its flag in the SAME statement, so an erased merge row cannot bring it back', () => {
    expect(COMPLETE_MERGE_SQL).toContain('UPDATE alumni_merges SET "completedAt" = now()');
    expect(COMPLETE_MERGE_SQL).toContain('UPDATE alumni_duplicate_flags SET "resolvedAt" = now()');
    expect(COMPLETE_MERGE_SQL.match(/;/g)).toBeNull();
  });

  describe('the one rule of what the mark accepts (autoMergeRefusal)', () => {
    const ok = { dupSlugs: ['alumni'], matchUuids: [TARGET_UUID], targetSlugs: ['cas-emse'] };
    it('accepts exactly one match, links exactly [alumni], a target without an Alumni link', () => {
      expect(autoMergeRefusal(ok)).toBeNull();
      expect(autoMergeRefusal({ ...ok, targetUuid: TARGET_UUID })).toBeNull();
    });
    it.each([
      ['links beyond alumni', { ...ok, dupSlugs: ['alumni', 'cas-emse'] }, 'not_duplicate'],
      ['no match', { ...ok, matchUuids: [] }, 'no_match'],
      ['a homonym', { ...ok, matchUuids: [TARGET_UUID, DUP_UUID] }, 'no_match'],
      ['another target than the match', { ...ok, targetUuid: DUP_UUID }, 'no_match'],
      ['a target already linked to Alumni', { ...ok, targetSlugs: ['alumni'] }, 'no_match'],
    ])('refuses %s', (_name, input, kind) => {
      expect(autoMergeRefusal(input)?.kind).toBe(kind);
    });
  });

  it('the queue filter and the mark agree: isAutoMergeable is the same verdict', async () => {
    expect(await make([DUP, TARGET]).service.isAutoMergeable(DUP_UUID)).toBe(true);
    const homonym = person({
      pk: 3,
      uuid: '44444444-4444-4444-8444-444444444444',
      username: 'camille.durand2',
    });
    expect(await make([DUP, TARGET, homonym]).service.isAutoMergeable(DUP_UUID)).toBe(false);
    expect(await make([TARGET]).service.isAutoMergeable(TARGET_UUID)).toBe(false);
    expect(await make([]).service.isAutoMergeable(DUP_UUID)).toBe(false);
  });

  it('a mark that fails half-way still recounts the admins (the requested row keeps the item pending)', async () => {
    let inserted = false;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO alumni_merges')) {
        inserted = true;
        return [{ id: 'row-1' }];
      }
      if (sql.includes('FROM alumni_merges') && inserted) {
        return [
          {
            id: 'row-1',
            duplicateUuid: DUP_UUID,
            duplicateUsername: 'alumni-0001',
            targetUuid: TARGET_UUID,
            held: {},
            requestedAt: new Date(),
            markedAt: null,
          },
        ];
      }
      return [];
    });
    const { service, editor } = make([DUP, TARGET], query);
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        personalPosts: 0,
        associations: 0,
        communities: 0,
        formSubmissions: 0,
        conversations: 0,
      },
    });
    editor.writeUser.mockRejectedValueOnce(new Error('authentik down'));
    await expect(service.merge(DUP_UUID, TARGET_UUID, 'admin-1')).rejects.toThrow('authentik down');
    expect(editor.writeUser).toHaveBeenCalledTimes(1);
    expect(queue.changed).toHaveBeenCalledTimes(1);
  });

  it('cancelling a mark recounts the admins: the duplicate waits again', async () => {
    const open = {
      id: 'row-1',
      duplicateUuid: DUP_UUID,
      duplicateUsername: 'alumni-0001',
      targetUuid: TARGET_UUID,
      held: {},
      requestedAt: new Date(),
      markedAt: new Date(),
    };
    const query = jest.fn(async (sql: string) => (sql.includes('SELECT id') ? [open] : []));
    const { service } = make([DUP, TARGET], query);
    await service.cancel(DUP_UUID, 'admin-1');
    expect(queue.changed).toHaveBeenCalledTimes(1);
  });
});
