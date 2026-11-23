import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { DataSource } from 'typeorm';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import {
  AlumniMergeService,
  normalizeName,
  promosOf,
  sameNameAndPromo,
} from './alumni-merge.service';
import {
  AlumniMergeHoldingsUnavailableError,
  AlumniMergeNoMatchError,
  AlumniMergeNotDuplicateError,
  AlumniMergeNotFoundError,
} from './alumni-merge.errors';
import type { MiconnectEditorClient, MiconnectUserListing } from './miconnect-editor.client';
import { ProfileEditUnavailableOnDevError } from './profile-edit.errors';

jest.mock('axios');

const DUP_UUID = '11111111-1111-4111-8111-111111111111';
const TARGET_UUID = '22222222-2222-4222-8222-222222222222';

const person = (over: Partial<MiconnectUserListing>): MiconnectUserListing => ({
  pk: 1,
  uuid: DUP_UUID,
  username: 'alumni-0001',
  name: 'Camille Durand',
  type: 'internal',
  attributes: { profile: { cursus: [{ formation: 'ICM', promo: 2020 }] } },
  ...over,
});
const DUP = person({});
const TARGET = person({
  pk: 2,
  uuid: TARGET_UUID,
  username: 'camille.durand',
  name: 'Camille DURAND',
});

describe('the duplicate rule (D47)', () => {
  it('folds accents, case, hyphens and spaces in a name', () => {
    expect(normalizeName('  Jean-Marie  DUPONT ')).toBe(normalizeName('jean marie Dupont'));
    expect(normalizeName('Hélène')).toBe('helene');
  });

  it('reads the promos of a profile, the malformed entries ignored', () => {
    expect(
      promosOf({ profile: { cursus: [{ promo: 2020 }, { promo: '2021' }, null, { promo: 2020 }] } })
    ).toEqual([2020]);
    expect(promosOf({})).toEqual([]);
  });

  it('needs the same name AND a promo in common', () => {
    const a = { name: 'Camille Durand', promos: [2020] };
    expect(sameNameAndPromo(a, { name: 'camille DURAND', promos: [2019, 2020] })).toBe(true);
    expect(sameNameAndPromo(a, { name: 'Camille Durand', promos: [2021] })).toBe(false);
    expect(sameNameAndPromo(a, { name: 'Camille Dupont', promos: [2020] })).toBe(false);
    expect(sameNameAndPromo({ name: ' ', promos: [2020] }, { name: '', promos: [2020] })).toBe(
      false
    );
  });
});

describe('AlumniMergeService', () => {
  let log: jest.SpyInstance[];
  beforeEach(() => {
    log = (['log', 'warn', 'error'] as const).map((l) =>
      jest.spyOn(Logger.prototype, l).mockImplementation(() => undefined)
    );
    (axios.get as jest.Mock).mockReset();
  });
  afterEach(() => log.forEach((s) => s.mockRestore()));

  /**
   * A service over fakes: MiConnect holds `accounts` (uuid -> account and its source slugs), Canari
   * maps uuids to ids (`canari`), and `alumni_merges` is an array of rows.
   */
  function make(opts: {
    accounts?: Record<string, { user: MiconnectUserListing; slugs: string[] }>;
    canari?: Record<string, string>;
    pending?: { targetUuid: string; held: unknown } | null;
  }) {
    const accounts = { ...opts.accounts };
    const canari = { ...opts.canari };
    const writes: string[] = [];
    const editor = {
      assertAvailable: jest.fn(() => ({ baseUrl: 'https://mc', token: 't' })),
      searchUsers: jest.fn(async (q: string) =>
        Object.values(accounts)
          .map((a) => a.user)
          .filter((u) => normalizeName(`${u.username} ${u.name}`).includes(normalizeName(q)))
      ),
      usersByUuid: jest.fn(async (uuid: string) => (accounts[uuid] ? [accounts[uuid].user] : [])),
      sourceSlugsOf: jest.fn(
        async (pk: number) => Object.values(accounts).find((a) => a.user.pk === pk)?.slugs ?? []
      ),
      deleteUser: jest.fn(async (pk: number) => {
        const uuid = Object.keys(accounts).find((k) => accounts[k].user.pk === pk)!;
        delete accounts[uuid];
      }),
    };
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM users')) {
          return (params[0] as string[])
            .filter((u) => canari[u])
            .map((u) => ({ id: canari[u], miconnectUuid: u }));
        }
        if (sql.includes('SELECT "targetUuid"')) return opts.pending ? [opts.pending] : [];
        writes.push(sql.trim().split(/\s+/)[0]);
        return [];
      }),
    };
    const erasure = { requestErasure: jest.fn(async () => undefined) };
    const service = new AlumniMergeService(
      dataSource as unknown as DataSource,
      editor as unknown as MiconnectEditorClient,
      erasure as unknown as AccountErasureService
    );
    return { service, editor, erasure, writes, accounts };
  }

  const holdingsAnswer = () =>
    (axios.get as jest.Mock).mockImplementation(async (url: string) => ({
      data: url.includes('chat-delivery')
        ? { conversations: 4 }
        : { personalPosts: 3, associations: 1, communities: 2, formSubmissions: 5 },
    }));

  it('lists an Alumni-created account matching a CAS account, and nothing else', async () => {
    const stranger = person({ pk: 3, uuid: 'x', username: 'alumni-0002', name: 'Other One' });
    const { service } = make({
      accounts: {
        [DUP_UUID]: { user: DUP, slugs: ['alumni'] },
        [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse'] },
        x: { user: stranger, slugs: ['alumni'] },
      },
      canari: { [TARGET_UUID]: 'canari-target' },
    });
    const list = await service.listDuplicates();
    expect(list).toEqual([
      {
        duplicate: expect.objectContaining({ uuid: DUP_UUID, canariUserId: null }),
        targets: [expect.objectContaining({ uuid: TARGET_UUID, canariUserId: 'canari-target' })],
      },
    ]);
  });

  it('counts what the duplicate holds through social and chat-delivery', async () => {
    holdingsAnswer();
    const { service } = make({ canari: { [DUP_UUID]: 'canari-dup' } });
    expect(await service.holdings(DUP_UUID)).toEqual({
      canariAccount: true,
      personalPosts: 3,
      associations: 1,
      communities: 2,
      formSubmissions: 5,
      conversations: 4,
    });
  });

  it('refuses a partial count: a service that does not answer is not a zero', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = make({ canari: { [DUP_UUID]: 'canari-dup' } });
    await expect(service.holdings(DUP_UUID)).rejects.toBeInstanceOf(
      AlumniMergeHoldingsUnavailableError
    );
  });

  it('merges: traces, deletes at MiConnect, erases the Canari account, completes the trace', async () => {
    holdingsAnswer();
    const { service, editor, erasure, writes, accounts } = make({
      accounts: {
        [DUP_UUID]: { user: DUP, slugs: ['alumni'] },
        [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse'] },
      },
      canari: { [DUP_UUID]: 'canari-dup', [TARGET_UUID]: 'canari-target' },
    });
    const out = await service.merge(DUP_UUID, TARGET_UUID, 'admin-1');
    expect(out.resumed).toBe(false);
    expect(out.held.personalPosts).toBe(3);
    expect(editor.deleteUser).toHaveBeenCalledWith(DUP.pk);
    expect(accounts[DUP_UUID]).toBeUndefined();
    expect(accounts[TARGET_UUID]).toBeDefined();
    expect(erasure.requestErasure).toHaveBeenCalledWith('canari-dup');
    // The trace is written BEFORE the deletion and completed after the erasure.
    expect(writes).toEqual(['INSERT', 'UPDATE']);
    expect(editor.deleteUser.mock.invocationCallOrder[0]).toBeLessThan(
      erasure.requestErasure.mock.invocationCallOrder[0]
    );
  });

  it('resumes a merge MiConnect already carried out: only the erasure is left', async () => {
    const { service, editor, erasure } = make({
      accounts: { [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse'] } },
      canari: { [DUP_UUID]: 'canari-dup' },
      pending: { targetUuid: TARGET_UUID, held: { personalPosts: 7 } },
    });
    const out = await service.merge(DUP_UUID, TARGET_UUID, 'admin-1');
    expect(out).toEqual({ resumed: true, held: { personalPosts: 7 } });
    expect(editor.deleteUser).not.toHaveBeenCalled();
    expect(erasure.requestErasure).toHaveBeenCalledWith('canari-dup');
  });

  it('answers 404 for a duplicate that is gone with nothing pending', async () => {
    const { service } = make({});
    await expect(service.merge(DUP_UUID, TARGET_UUID, 'a')).rejects.toBeInstanceOf(
      AlumniMergeNotFoundError
    );
  });

  describe('the allowlist: nothing is deleted outside it', () => {
    const cases: [string, Parameters<typeof make>[0], new (...a: never[]) => Error][] = [
      [
        'an account an Alumni sign-in did not create',
        {
          accounts: {
            [DUP_UUID]: { user: { ...DUP, username: 'camille.d' }, slugs: ['alumni'] },
            [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse'] },
          },
        },
        AlumniMergeNotDuplicateError,
      ],
      [
        'a duplicate also linked to the CAS',
        {
          accounts: {
            [DUP_UUID]: { user: DUP, slugs: ['alumni', 'cas-emse'] },
            [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse'] },
          },
        },
        AlumniMergeNotDuplicateError,
      ],
      [
        'a target that is itself Alumni-created',
        {
          accounts: {
            [DUP_UUID]: { user: DUP, slugs: ['alumni'] },
            [TARGET_UUID]: { user: { ...TARGET, username: 'alumni-9' }, slugs: ['alumni'] },
          },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'a target of another promo',
        {
          accounts: {
            [DUP_UUID]: { user: DUP, slugs: ['alumni'] },
            [TARGET_UUID]: {
              user: { ...TARGET, attributes: { profile: { cursus: [{ promo: 2019 }] } } },
              slugs: ['cas-emse'],
            },
          },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'a pending merge into another account',
        {
          accounts: {
            [DUP_UUID]: { user: DUP, slugs: ['alumni'] },
            [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse'] },
          },
          pending: { targetUuid: 'someone-else', held: {} },
        },
        AlumniMergeNoMatchError,
      ],
    ];
    for (const [name, world, error] of cases) {
      it(`refuses ${name}`, async () => {
        const { service, editor, erasure } = make(world);
        await expect(service.merge(DUP_UUID, TARGET_UUID, 'a')).rejects.toBeInstanceOf(error);
        expect(editor.deleteUser).not.toHaveBeenCalled();
        expect(erasure.requestErasure).not.toHaveBeenCalled();
      });
    }
  });

  it('refuses on the dev estate before reading anything', async () => {
    const { service, editor } = make({});
    editor.assertAvailable.mockImplementation(() => {
      throw new ProfileEditUnavailableOnDevError();
    });
    await expect(service.merge(DUP_UUID, TARGET_UUID, 'a')).rejects.toBeInstanceOf(
      ProfileEditUnavailableOnDevError
    );
    expect(editor.usersByUuid).not.toHaveBeenCalled();
  });
});
