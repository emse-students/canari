import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { DataSource } from 'typeorm';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import {
  AlumniMergeService,
  RESOLVE_DUPLICATE_FLAG_SQL,
  duplicateShapeRefusal,
} from './alumni-merge.service';
import type { AlumniMergeSiteJobsService } from './alumni-merge-site-jobs.service';
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
  uid: 'sub-1',
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
      {
        query,
        transaction: async (cb: (m: { query: typeof query }) => unknown) => cb({ query }),
      } as unknown as DataSource,
      editor as unknown as MiconnectEditorClient,
      {} as AccountErasureService,
      {} as AlumniMergeSiteJobsService
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

    it('flags a duplicate that matches nobody, or several: a merge by hand (D55) is its action, nothing is merged by itself', async () => {
      const alone = make([DUP]);
      await alone.service.flagNewAccount(DUP_UUID);
      expect(queue.flag).toHaveBeenCalledWith(DUP_UUID);
      queue.flag.mockClear();
      const homonym = person({
        pk: 3,
        uuid: '44444444-4444-4444-8444-444444444444',
        username: 'camille.durand2',
      });
      await make([DUP, TARGET, homonym]).service.flagNewAccount(DUP_UUID);
      expect(queue.flag).toHaveBeenCalledWith(DUP_UUID);
    });

    it('never flags a duplicate whose links are not exactly [alumni]', async () => {
      const { service, editor } = make([DUP, TARGET]);
      editor.sourceSlugsOf.mockImplementation(async () => ['alumni', 'cas-emse']);
      await service.flagNewAccount(DUP_UUID);
      expect(queue.flag).not.toHaveBeenCalled();
    });

    it('flags nothing for an account no Alumni sign-in created, and reads no links', async () => {
      const { service, editor } = make([TARGET]);
      await service.flagNewAccount(TARGET_UUID);
      expect(queue.flag).not.toHaveBeenCalled();
      expect(editor.sourceSlugsOf).not.toHaveBeenCalled();
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

  it('the flag is resolved by ONE statement keyed on the closed duplicate, never on a row that may be erased', () => {
    expect(RESOLVE_DUPLICATE_FLAG_SQL).toContain(
      'UPDATE alumni_duplicate_flags SET "resolvedAt" = now()'
    );
    expect(RESOLVE_DUPLICATE_FLAG_SQL).not.toContain('alumni_merges');
    expect(RESOLVE_DUPLICATE_FLAG_SQL.match(/;/g)).toBeNull();
  });

  describe('the one rule of what an admin can act on (duplicateShapeRefusal)', () => {
    it('accepts a person created by an Alumni sign-in whose links are exactly [alumni]', () => {
      expect(duplicateShapeRefusal(DUP, ['alumni'])).toBeNull();
    });
    it.each([
      ['links beyond alumni', DUP, ['alumni', 'cas-emse'], 'not [alumni]'],
      ['no link', DUP, [], 'not [alumni]'],
      ['an account no Alumni sign-in created', TARGET, ['alumni'], 'not created by an Alumni'],
      [
        'a service account',
        person({ type: 'service_account' }),
        ['alumni'],
        'not created by an Alumni',
      ],
    ])('refuses %s', (_name, user, slugs, reason) => {
      expect(duplicateShapeRefusal(user, slugs)).toContain(reason);
    });
  });

  it('the queue filter and the mark agree: isFlaggable is the same verdict', async () => {
    expect(await make([DUP, TARGET]).service.isFlaggable(DUP_UUID)).toBe(true);
    expect(await make([DUP]).service.isFlaggable(DUP_UUID)).toBe(true);
    expect(await make([TARGET]).service.isFlaggable(TARGET_UUID)).toBe(false);
    expect(await make([]).service.isFlaggable(DUP_UUID)).toBe(false);
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
