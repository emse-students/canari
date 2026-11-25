import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { DataSource } from 'typeorm';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import {
  AlumniMergeService,
  MERGE_MARK,
  normalizeName,
  promosOf,
  sameNameAndPromo,
} from './alumni-merge.service';
import {
  AlumniMergeAlreadyMergedError,
  AlumniMergeHoldingsUnavailableError,
  AlumniMergeInProgressError,
  AlumniMergeNoMatchError,
  AlumniMergeNotDuplicateError,
  AlumniMergeNotFoundError,
} from './alumni-merge.errors';
import type { MiconnectEditorClient, MiconnectUserListing } from './miconnect-editor.client';
import { ProfileEditUnavailableOnDevError } from './profile-edit.errors';

jest.mock('axios');

const DUP_UUID = '11111111-1111-4111-8111-111111111111';
const TARGET_UUID = '22222222-2222-4222-8222-222222222222';
const HOMONYM_UUID = '33333333-3333-4333-8333-333333333333';

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
const TARGET = person({
  pk: 2,
  uuid: TARGET_UUID,
  username: 'camille.durand',
  name: 'Camille DURAND',
  last_login: '2026-11-01T10:00:00Z',
});

describe('the duplicate rule (D47)', () => {
  it('folds accents, case, hyphens and spaces in a name', () => {
    expect(normalizeName('  Jean-Marie  DUPONT ')).toBe(normalizeName('jean marie Dupont'));
    expect(normalizeName('Hélène')).toBe('helene');
    // The same steps as MiConnect's merge policy (30-sources.yaml, `folded`).
    expect(normalizeName('Œuvray-Lætitia')).toBe('oeuvray laetitia');
    expect(normalizeName('D’Artagnan J.-M.')).toBe('d artagnan j m');
    expect(normalizeName('Dupont2')).toBe('dupont2');
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

/** An `alumni_merges` row of the fake table. */
interface Row {
  id: string;
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  held: unknown;
  requestedAt: Date;
  markedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy?: string | null;
}

describe('AlumniMergeService', () => {
  let log: Record<'log' | 'warn' | 'error', jest.SpyInstance>;
  beforeEach(() => {
    log = {
      log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
    };
    (axios.get as jest.Mock).mockReset();
  });
  afterEach(() => Object.values(log).forEach((s) => s.mockRestore()));

  /**
   * A service over fakes: MiConnect holds `accounts` (uuid -> account and its source slugs), Canari
   * maps uuids to ids (`canari`), and `alumni_merges` is the array `rows`.
   */
  function make(opts: {
    accounts?: Record<
      string,
      { user: MiconnectUserListing; slugs: string[]; ids?: Record<string, string> }
    >;
    canari?: Record<string, string>;
    rows?: Partial<Row>[];
    /** The INSERT loses a race: another request's row appears instead of this one's. */
    raced?: boolean;
  }) {
    const accounts = structuredClone(opts.accounts ?? {});
    const canari = { ...opts.canari };
    const rows: Row[] = (opts.rows ?? []).map((r, i) => ({
      id: `row-${i}`,
      duplicateUuid: DUP_UUID,
      duplicateUsername: 'alumni-0001',
      targetUuid: TARGET_UUID,
      held: {},
      requestedAt: new Date(),
      markedAt: null,
      completedAt: null,
      cancelledAt: null,
      ...r,
    }));
    const isOpen = (r: Row) => !r.completedAt;
    const editor = {
      assertAvailable: jest.fn(() => ({ baseUrl: 'https://mc', token: 't' })),
      searchUsers: jest.fn(async (q: string) =>
        Object.values(accounts)
          .map((a) => a.user)
          .filter((u) => normalizeName(`${u.username} ${u.name}`).includes(normalizeName(q)))
      ),
      userByUuid: jest.fn(async (uuid: string) => accounts[uuid]?.user ?? null),
      sourceSlugsOf: jest.fn(
        async (pk: number) => Object.values(accounts).find((a) => a.user.pk === pk)?.slugs ?? []
      ),
      sourceLinksOf: jest.fn(async (pk: number) => {
        const found = Object.values(accounts).find((a) => a.user.pk === pk);
        return (found?.slugs ?? []).map((slug) => ({
          slug,
          identifier: found?.ids?.[slug] ?? null,
        }));
      }),
      // As MiConnect's write flow does: the named keys MERGED into the stored bag, null removing one.
      writeUser: jest.fn(
        async (uuid: string, changes: { attributes?: Record<string, unknown> }) => {
          const found = accounts[uuid]!;
          const next = { ...found.user.attributes };
          for (const [key, value] of Object.entries(changes.attributes ?? {})) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          found.user = { ...found.user, attributes: next };
        }
      ),
    };
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM users')) {
          return (params[0] as string[])
            .filter((u) => canari[u])
            .map((u) => ({ id: canari[u], miconnectUuid: u }));
        }
        if (sql.includes('FROM alumni_merges')) {
          return rows.filter(
            (r) => isOpen(r) && (params.length === 0 || r.duplicateUuid === params[0])
          );
        }
        if (sql.startsWith('INSERT')) {
          if (opts.raced) {
            rows.push({ ...rows[0], id: 'other', targetUuid: params[3] as string } as Row);
            return [];
          }
          if (rows.some((r) => isOpen(r) && r.duplicateUuid === params[1])) return [];
          rows.push({
            id: `row-${rows.length}`,
            duplicateUuid: params[1] as string,
            duplicateUsername: params[2] as string,
            targetUuid: params[3] as string,
            held: JSON.parse(params[5] as string),
            requestedAt: new Date(),
            markedAt: null,
            completedAt: null,
            cancelledAt: null,
          });
          return [{ id: rows[rows.length - 1].id }];
        }
        const row = rows.find((r) => r.id === params[0] && isOpen(r));
        if (row && sql.includes('"markedAt" = COALESCE')) row.markedAt ??= new Date();
        if (row && sql.includes('"completedAt" = now()')) row.completedAt = new Date();
        if (row && sql.includes('"cancelledAt" = now()')) {
          row.cancelledAt = new Date();
          row.cancelledBy = params[1] as string;
        }
        return [];
      }),
    };
    const erasure = { requestErasure: jest.fn(async () => undefined) };
    const service = new AlumniMergeService(
      dataSource as unknown as DataSource,
      editor as unknown as MiconnectEditorClient,
      erasure as unknown as AccountErasureService
    );
    return { service, editor, erasure, rows, accounts };
  }

  const holdingsAnswer = () =>
    (axios.get as jest.Mock).mockImplementation(async (url: string) => ({
      data: url.includes('chat-delivery')
        ? { conversations: 4 }
        : { personalPosts: 3, associations: 1, communities: 2, formSubmissions: 5 },
    }));

  const world = () => ({
    [DUP_UUID]: { user: DUP, slugs: ['alumni'] },
    [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse'] },
  });

  it('lists an Alumni-created account matching a CAS account, with what tells homonyms apart', async () => {
    const stranger = person({ pk: 3, uuid: 'x', username: 'alumni-0002', name: 'Other One' });
    const { service } = make({
      accounts: { ...world(), x: { user: stranger, slugs: ['alumni'] } },
      canari: { [TARGET_UUID]: 'canari-target' },
    });
    expect(await service.listDuplicates()).toEqual([
      {
        duplicate: expect.objectContaining({ uuid: DUP_UUID, canariUserId: null }),
        targets: [
          expect.objectContaining({
            uuid: TARGET_UUID,
            canariUserId: 'canari-target',
            email: 'camille@example.org',
            lastLogin: '2026-11-01T10:00:00Z',
          }),
        ],
      },
    ]);
  });

  it('does not list as a duplicate one already in an open merge', async () => {
    const { service } = make({ accounts: world(), rows: [{ markedAt: new Date() }] });
    expect(await service.listDuplicates()).toEqual([]);
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

  it('marks: traces, writes the mark at MiConnect, then MARKED - and erases nothing yet', async () => {
    holdingsAnswer();
    const { service, editor, erasure, rows, accounts } = make({
      accounts: world(),
      canari: { [DUP_UUID]: 'canari-dup', [TARGET_UUID]: 'canari-target' },
    });
    const out = await service.merge(DUP_UUID, TARGET_UUID, 'admin-1');
    expect(out.status).toBe('marked');
    expect((out.held as { personalPosts: number }).personalPosts).toBe(3);
    const marked = accounts[DUP_UUID].user.attributes;
    expect(marked[MERGE_MARK.into]).toBe(TARGET_UUID);
    expect(marked[MERGE_MARK.by]).toBe('admin-1');
    expect(typeof marked[MERGE_MARK.at]).toBe('string');
    expect(marked.profile).toEqual(DUP.attributes.profile);
    expect(accounts[TARGET_UUID].user.attributes).toEqual(TARGET.attributes);
    expect(erasure.requestErasure).not.toHaveBeenCalled();
    expect(editor.writeUser).toHaveBeenCalledTimes(1);
    expect(editor.writeUser).toHaveBeenCalledWith(DUP_UUID, {
      attributes: {
        [MERGE_MARK.into]: TARGET_UUID,
        [MERGE_MARK.by]: 'admin-1',
        [MERGE_MARK.at]: expect.any(String),
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].markedAt).not.toBeNull();
  });

  it('names only the mark: an edit made meanwhile at MiConnect is kept', async () => {
    const { service, editor, accounts } = make({ accounts: world() });
    const first = accounts[DUP_UUID].user;
    editor.userByUuid.mockImplementationOnce(async () => first);
    accounts[DUP_UUID] = {
      ...accounts[DUP_UUID],
      user: { ...first, attributes: { ...first.attributes, edited: 'meanwhile' } },
    };
    await service.merge(DUP_UUID, TARGET_UUID, 'admin-1');
    expect(accounts[DUP_UUID].user.attributes.edited).toBe('meanwhile');
    expect(accounts[DUP_UUID].user.attributes[MERGE_MARK.into]).toBe(TARGET_UUID);
  });

  it('resumes an interrupted merge: the same row, marked again, nothing erased', async () => {
    const { service, erasure, rows } = make({
      accounts: world(),
      canari: { [DUP_UUID]: 'canari-dup' },
      rows: [{ held: { personalPosts: 7 } }],
    });
    const out = await service.merge(DUP_UUID, TARGET_UUID, 'admin-1');
    expect(out).toEqual({ status: 'marked', held: { personalPosts: 7 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].markedAt).not.toBeNull();
    expect(erasure.requestErasure).not.toHaveBeenCalled();
  });

  it('stops when another request opened the merge first: nothing marked, nothing erased', async () => {
    holdingsAnswer();
    const { service, editor, erasure } = make({ accounts: world(), raced: true });
    await expect(service.merge(DUP_UUID, TARGET_UUID, 'a')).rejects.toBeInstanceOf(
      AlumniMergeInProgressError
    );
    expect(editor.writeUser).not.toHaveBeenCalled();
    expect(erasure.requestErasure).not.toHaveBeenCalled();
  });

  it('answers 404 for a duplicate that is gone with nothing open', async () => {
    const { service } = make({});
    await expect(service.merge(DUP_UUID, TARGET_UUID, 'a')).rejects.toBeInstanceOf(
      AlumniMergeNotFoundError
    );
  });

  describe('the allowlist: nothing is marked outside it', () => {
    const homonym = person({ pk: 4, uuid: HOMONYM_UUID, username: 'camille.durand2' });
    const cases: [string, Parameters<typeof make>[0], new (...a: never[]) => Error][] = [
      [
        'an account an Alumni sign-in did not create',
        {
          accounts: {
            ...world(),
            [DUP_UUID]: { user: { ...DUP, username: 'camille.d' }, slugs: ['alumni'] },
          },
        },
        AlumniMergeNotDuplicateError,
      ],
      [
        'a duplicate also linked to the CAS',
        { accounts: { ...world(), [DUP_UUID]: { user: DUP, slugs: ['alumni', 'cas-emse'] } } },
        AlumniMergeNotDuplicateError,
      ],
      [
        'a duplicate with no link at all',
        { accounts: { ...world(), [DUP_UUID]: { user: DUP, slugs: [] } } },
        AlumniMergeNotDuplicateError,
      ],
      [
        'a target that is itself Alumni-created',
        {
          accounts: {
            ...world(),
            [TARGET_UUID]: { user: { ...TARGET, username: 'alumni-9' }, slugs: ['alumni'] },
          },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'a target of another promo',
        {
          accounts: {
            ...world(),
            [TARGET_UUID]: {
              user: { ...TARGET, attributes: { profile: { cursus: [{ promo: 2019 }] } } },
              slugs: ['cas-emse'],
            },
          },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'a target that already holds an Alumni link',
        {
          accounts: { ...world(), [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse', 'alumni'] } },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'an inactive target',
        {
          accounts: {
            ...world(),
            [TARGET_UUID]: { user: { ...TARGET, is_active: false }, slugs: ['cas-emse'] },
          },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'a match that a homonym makes ambiguous',
        { accounts: { ...world(), [HOMONYM_UUID]: { user: homonym, slugs: ['cas-emse'] } } },
        AlumniMergeNoMatchError,
      ],
      [
        'an open merge into another account',
        { accounts: world(), rows: [{ targetUuid: 'someone-else' }] },
        AlumniMergeNoMatchError,
      ],
    ];
    for (const [name, state, error] of cases) {
      it(`refuses ${name}`, async () => {
        const { service, editor, erasure } = make(state);
        await expect(service.merge(DUP_UUID, TARGET_UUID, 'a')).rejects.toBeInstanceOf(error);
        expect(editor.writeUser).not.toHaveBeenCalled();
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
    expect(editor.userByUuid).not.toHaveBeenCalled();
  });

  describe('the open merges', () => {
    it('lists a marked merge waiting for the sign-in', async () => {
      const { service } = make({ accounts: world(), rows: [{ markedAt: new Date() }] });
      expect(await service.listOpenMerges()).toEqual([
        expect.objectContaining({ duplicateUuid: DUP_UUID, status: 'marked' }),
      ]);
      expect(log.error).not.toHaveBeenCalled();
    });

    it('completes, erases the Canari duplicate, and no longer lists one MiConnect merged', async () => {
      const { service, rows, erasure } = make({
        accounts: {
          [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse', 'alumni'], ids: { alumni: '0001' } },
        },
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date() }],
      });
      expect(await service.listOpenMerges()).toEqual([]);
      expect(erasure.requestErasure).toHaveBeenCalledWith('canari-dup');
      expect(rows[0].completedAt).not.toBeNull();
      expect(log.error).not.toHaveBeenCalled();
    });

    it("erases nothing when the target holds an Alumni link that is not the duplicate's", async () => {
      const { service, erasure } = make({
        accounts: {
          [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse', 'alumni'], ids: { alumni: '0999' } },
        },
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date() }],
      });
      expect(await service.listOpenMerges()).toEqual([]);
      expect(erasure.requestErasure).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('not a merge, nothing erased')
      );
    });

    it('erases nothing when a marked duplicate is gone but the target holds no Alumni link', async () => {
      const { service, rows, erasure } = make({
        accounts: { [TARGET_UUID]: world()[TARGET_UUID] },
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date() }],
      });
      expect(await service.listOpenMerges()).toEqual([]);
      expect(erasure.requestErasure).not.toHaveBeenCalled();
      expect(rows[0].completedAt).not.toBeNull();
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('not a merge, nothing erased')
      );
    });

    it('erases nothing for a marked row whose target an erasure blanked', async () => {
      const { service, erasure, editor } = make({
        accounts: {},
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date(), targetUuid: '[deleted]' }],
      });
      expect(await service.listOpenMerges()).toEqual([]);
      expect(erasure.requestErasure).not.toHaveBeenCalled();
      expect(editor.userByUuid).not.toHaveBeenCalledWith('[deleted]');
    });

    it('completes without erasing a requested row whose duplicate left MiConnect unmarked', async () => {
      const { service, rows, erasure } = make({
        accounts: { [TARGET_UUID]: world()[TARGET_UUID] },
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{}],
      });
      expect(await service.listOpenMerges()).toEqual([]);
      expect(erasure.requestErasure).not.toHaveBeenCalled();
      expect(rows[0].completedAt).not.toBeNull();
    });

    it('logs at error a merge requested long ago and never marked', async () => {
      const { service } = make({
        accounts: world(),
        rows: [{ requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }],
      });
      expect(await service.listOpenMerges()).toEqual([
        expect.objectContaining({ status: 'requested' }),
      ]);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('[ALUMNI_MERGE] interrupted'));
    });

    it('cancels: the mark removed at MiConnect, every other attribute kept, the row CANCELLED', async () => {
      const marked = {
        ...DUP,
        attributes: { ...DUP.attributes, [MERGE_MARK.into]: TARGET_UUID, [MERGE_MARK.by]: 'a' },
      };
      const { service, rows, accounts, editor } = make({
        accounts: { ...world(), [DUP_UUID]: { user: marked, slugs: ['alumni'] } },
        rows: [{ markedAt: new Date() }],
      });
      await service.cancel(DUP_UUID, 'admin-2');
      expect(editor.writeUser).toHaveBeenCalledWith(DUP_UUID, {
        attributes: { [MERGE_MARK.into]: null, [MERGE_MARK.by]: null, [MERGE_MARK.at]: null },
      });
      expect(accounts[DUP_UUID].user.attributes).toEqual(DUP.attributes);
      expect(rows[0].cancelledAt).not.toBeNull();
      expect(rows[0].completedAt).not.toBeNull();
      expect(rows[0].cancelledBy).toBe('admin-2');
    });

    it('refuses a cancel that comes after MiConnect merged, and completes the row', async () => {
      const { service, rows } = make({
        accounts: { [TARGET_UUID]: world()[TARGET_UUID] },
        rows: [{ markedAt: new Date() }],
      });
      await expect(service.cancel(DUP_UUID, 'a')).rejects.toBeInstanceOf(
        AlumniMergeAlreadyMergedError
      );
      expect(rows[0].completedAt).not.toBeNull();
    });

    it('answers 404 to a cancel with nothing open', async () => {
      const { service } = make({ accounts: world() });
      await expect(service.cancel(DUP_UUID, 'a')).rejects.toBeInstanceOf(AlumniMergeNotFoundError);
    });
  });
});
