import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import { AlumniMergeService } from './alumni-merge.service';
import type { AlumniDuplicateQueue } from './alumni-duplicate-queue.service';
import type { MiconnectEditorClient, MiconnectUserListing } from './miconnect-editor.client';

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
