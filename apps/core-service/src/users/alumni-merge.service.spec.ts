import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { DataSource } from 'typeorm';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import { DELETED_ACCOUNT } from '../account-erasure/erasure-policy';
import {
  AlumniMergeService,
  MERGE_MARK,
  checkMergeReason,
  normalizeName,
  promosOf,
  sameNameAndPromo,
} from './alumni-merge.service';
import {
  ALUMNI_MERGE_REASON_MAX,
  ALUMNI_MERGE_REASON_MIN,
  AlumniMergeAlreadyMergedError,
  AlumniMergeHoldingsUnavailableError,
  AlumniMergeInProgressError,
  AlumniMergeNoMatchError,
  AlumniMergeNotDuplicateError,
  AlumniMergeNotFoundError,
  AlumniMergeNotMergedError,
  AlumniMergeReasonRequiredError,
  AlumniMergeTargetBusyError,
} from './alumni-merge.errors';
import type { AlumniMergeSiteJobsService } from './alumni-merge-site-jobs.service';
import type { MiconnectEditorClient, MiconnectUserListing } from './miconnect-editor.client';
import { ProfileEditUnavailableOnDevError } from './profile-edit.errors';

jest.mock('axios');

const DUP_UUID = '11111111-1111-4111-8111-111111111111';
const TARGET_UUID = '22222222-2222-4222-8222-222222222222';
const HOMONYM_UUID = '33333333-3333-4333-8333-333333333333';

const person = (over: Partial<MiconnectUserListing>): MiconnectUserListing => ({
  pk: 1,
  uuid: DUP_UUID,
  uid: 'sub-duplicate',
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
  uid: 'sub-target',
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
  actorId: string;
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  held: unknown;
  requestedAt: Date;
  markedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy?: string | null;
  mode: 'auto' | 'manual';
  reason: string | null;
  duplicateSubject: string | null;
  targetSubject: string | null;
  completedBy?: string | null;
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
      actorId: 'admin-1',
      duplicateUuid: DUP_UUID,
      duplicateUsername: 'alumni-0001',
      targetUuid: TARGET_UUID,
      held: {},
      requestedAt: new Date(),
      markedAt: null,
      completedAt: null,
      cancelledAt: null,
      mode: 'auto',
      reason: null,
      duplicateSubject: null,
      targetSubject: null,
      ...r,
    }));
    const isOpen = (r: Row) => !r.completedAt;
    /** The duplicates whose admin-queue flag a closing resolved (RESOLVE_DUPLICATE_FLAG_SQL). */
    const flagsResolved: string[] = [];
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
    const query = jest.fn(async (sql: string, params: unknown[] = []): Promise<unknown> => {
      if (sql.includes('UPDATE alumni_duplicate_flags')) {
        flagsResolved.push(params[0] as string);
        return [];
      }
      if (sql.includes('FROM users')) {
        return (params[0] as string[])
          .filter((u) => canari[u])
          .map((u) => ({ id: canari[u], miconnectUuid: u }));
      }
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('SELECT 1 FROM alumni_merges')) {
        return rows.filter(
          (r) => isOpen(r) && r.targetUuid === params[0] && r.duplicateUuid !== params[1]
        );
      }
      if (sql.includes('"completedAt" IS NOT NULL AND "cancelledAt" IS NULL')) {
        return rows.filter((r) => r.completedAt && !r.cancelledAt);
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
          actorId: params[0] as string,
          duplicateUuid: params[1] as string,
          duplicateUsername: params[2] as string,
          targetUuid: params[3] as string,
          held: JSON.parse(params[5] as string),
          requestedAt: new Date(),
          markedAt: null,
          completedAt: null,
          cancelledAt: null,
          mode: params[6] as 'auto' | 'manual',
          reason: params[7] as string | null,
          duplicateSubject: params[8] as string | null,
          targetSubject: params[9] as string | null,
        });
        return [{ id: rows[rows.length - 1].id }];
      }
      const row = rows.find((r) => r.id === params[0] && isOpen(r));
      if (row && sql.includes('"duplicateSubject" = COALESCE')) {
        row.duplicateSubject ??= params[1] as string | null;
        row.targetSubject ??= params[2] as string | null;
      }
      if (row && sql.includes('"markedAt" = COALESCE')) row.markedAt ??= new Date();
      if (row && sql.includes('SET "actorId" = $2')) row.actorId = params[1] as string;
      if (sql.includes('RETURNING id') && sql.includes('"completedAt" = now()')) {
        if (!row) return [[], 0];
        row.completedAt = new Date();
        row.completedBy = params[1] as string;
        return [
          [
            {
              id: row.id,
              duplicateUuid: row.duplicateUuid,
              targetUuid: row.targetUuid,
              targetSubject: row.targetSubject ?? null,
            },
          ],
          1,
        ];
      }
      if (row && sql.includes('"cancelledAt" = now()')) {
        row.cancelledAt = new Date();
        row.cancelledBy = params[1] as string;
        row.completedAt = new Date();
      }
      return [];
    });
    const dataSource = {
      query,
      transaction: jest.fn(async (cb: (m: { query: typeof query }) => unknown) => cb({ query })),
    };
    const erasure = { requestErasure: jest.fn(async () => undefined) };
    const siteJobs = {
      writeJobs: jest.fn(async () => undefined),
      drain: jest.fn(async () => undefined),
      statesOf: jest.fn(async () => new Map()),
    };
    const service = new AlumniMergeService(
      dataSource as unknown as DataSource,
      editor as unknown as MiconnectEditorClient,
      erasure as unknown as AccountErasureService,
      siteJobs as unknown as AlumniMergeSiteJobsService
    );
    return { service, editor, erasure, rows, accounts, siteJobs, flagsResolved };
  }

  const holdingsAnswer = () =>
    (axios.get as jest.Mock).mockImplementation(async (url: string) => ({
      data: url.includes('chat-delivery')
        ? { conversations: 4 }
        : { personalPosts: 3, associations: 1, communities: 2, formSubmissions: 5 },
    }));

  /** Both subjects, as the mark captures them (D54). */
  const subjects = { duplicateSubject: 'sub-duplicate', targetSubject: 'sub-target' };
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
      // D55: one that matches nobody is listed after, with no target, for a manual merge.
      { duplicate: expect.objectContaining({ uuid: 'x' }), targets: [] },
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
        [MERGE_MARK.mode]: 'auto',
        [MERGE_MARK.id]: rows[0].id,
        // An automatic mark clears the names a manual one carries.
        [MERGE_MARK.seenAlumniName]: null,
        [MERGE_MARK.seenTargetName]: null,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].markedAt).not.toBeNull();
    expect(out.mode).toBe('auto');
    // D54: both subjects stored at the mark, while both accounts exist.
    expect(rows[0].duplicateSubject).toBe('sub-duplicate');
    expect(rows[0].targetSubject).toBe('sub-target');
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
    expect(out).toEqual({ status: 'marked', held: { personalPosts: 7 }, mode: 'auto' });
    // A row from before 1.8.3 gets its subjects at its next reading while the duplicate exists.
    expect(rows[0].duplicateSubject).toBe('sub-duplicate');
    expect(rows[0].targetSubject).toBe('sub-target');
    expect(rows).toHaveLength(1);
    expect(rows[0].markedAt).not.toBeNull();
    expect(erasure.requestErasure).not.toHaveBeenCalled();
  });

  it('a resume by another admin records that admin on the row and on the mark', async () => {
    const { service, rows, accounts } = make({
      accounts: world(),
      rows: [{ actorId: 'admin-1', held: {} }],
    });
    await service.merge(DUP_UUID, TARGET_UUID, 'admin-2');
    expect(rows[0].actorId).toBe('admin-2');
    expect(accounts[DUP_UUID].user.attributes[MERGE_MARK.by]).toBe('admin-2');
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('resumed by another admin'));
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('opened by actor=admin-1'));
  });

  it('a resume by the same admin writes no actor change', async () => {
    const { service, rows } = make({ accounts: world(), rows: [{ actorId: 'admin-1' }] });
    await service.merge(DUP_UUID, TARGET_UUID, 'admin-1');
    expect(rows[0].actorId).toBe('admin-1');
    expect(log.log).not.toHaveBeenCalledWith(expect.stringContaining('resumed by another admin'));
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
        'a target of another promo, with no reason (a manual merge)',
        {
          accounts: {
            ...world(),
            [TARGET_UUID]: {
              user: { ...TARGET, attributes: { profile: { cursus: [{ promo: 2019 }] } } },
              slugs: ['cas-emse'],
            },
          },
        },
        AlumniMergeReasonRequiredError,
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
        'a match that a homonym makes ambiguous, with no reason (a manual merge)',
        { accounts: { ...world(), [HOMONYM_UUID]: { user: homonym, slugs: ['cas-emse'] } } },
        AlumniMergeReasonRequiredError,
      ],
      [
        'a superuser target',
        {
          accounts: {
            ...world(),
            [TARGET_UUID]: { user: { ...TARGET, is_superuser: true }, slugs: ['cas-emse'] },
          },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'a target with no CAS link',
        { accounts: { ...world(), [TARGET_UUID]: { user: TARGET, slugs: [] } } },
        AlumniMergeNoMatchError,
      ],
      [
        'a target another open merge already names',
        {
          accounts: world(),
          rows: [{ duplicateUuid: HOMONYM_UUID, duplicateUsername: 'alumni-0003' }],
        },
        AlumniMergeTargetBusyError,
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
        rows: [{ markedAt: new Date(), ...subjects }],
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
        attributes: Object.fromEntries(Object.values(MERGE_MARK).map((key) => [key, null])),
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

  /** A target that holds the duplicate's Alumni link: MiConnect merged it. */
  const merged = () => ({
    [TARGET_UUID]: { user: TARGET, slugs: ['cas-emse', 'alumni'], ids: { alumni: '0001' } },
  });

  describe('the push (D54)', () => {
    it('completes a merged row: by the push, the erasure requested, the three site jobs written', async () => {
      const { service, rows, erasure, siteJobs } = make({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      expect(await service.completeFromPush(DUP_UUID, TARGET_UUID, 'row-0')).toEqual({
        completed: true,
      });
      expect(rows[0].completedAt).not.toBeNull();
      expect(rows[0].completedBy).toBe('push');
      expect(erasure.requestErasure).toHaveBeenCalledWith('canari-dup');
      expect(siteJobs.writeJobs).toHaveBeenCalledWith(
        expect.anything(),
        'row-0',
        'sub-duplicate',
        'sub-target'
      );
      expect(siteJobs.drain).toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('by the reconciler'));
    });

    it('reads the target from the closing UPDATE: one erased after the proof yields erase jobs', async () => {
      const { service, rows, erasure, siteJobs } = make({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      // The target's erasure commits after the merge was read and proven, before the close.
      erasure.requestErasure.mockImplementation(async () => {
        rows[0].targetUuid = DELETED_ACCOUNT;
        rows[0].targetSubject = null;
      });
      await service.completeFromPush(DUP_UUID, TARGET_UUID, 'row-0', {
        duplicateSubject: 'sub-duplicate',
        targetSubject: 'sub-target',
      });
      expect(siteJobs.writeJobs).toHaveBeenCalledWith(
        expect.anything(),
        'row-0',
        'sub-duplicate',
        null
      );
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('target was erased meanwhile'));
      expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('differs'));
    });

    it('refuses a duplicate that still exists: nothing written, at error', async () => {
      const { service, rows, erasure, siteJobs } = make({
        accounts: world(),
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      await expect(service.completeFromPush(DUP_UUID, TARGET_UUID, '')).rejects.toBeInstanceOf(
        AlumniMergeNotMergedError
      );
      expect(rows[0].completedAt).toBeNull();
      expect(erasure.requestErasure).not.toHaveBeenCalled();
      expect(siteJobs.writeJobs).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('push refused'));
    });

    it("refuses a target that does not hold the duplicate's Alumni link", async () => {
      const { service, rows, erasure } = make({
        accounts: { [TARGET_UUID]: world()[TARGET_UUID] },
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      await expect(service.completeFromPush(DUP_UUID, TARGET_UUID, '')).rejects.toBeInstanceOf(
        AlumniMergeNotMergedError
      );
      expect(rows[0].completedAt).toBeNull();
      expect(erasure.requestErasure).not.toHaveBeenCalled();
    });

    it('answers a replayed push with already, and writes nothing', async () => {
      const { service, rows, erasure, siteJobs } = make({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      await service.completeFromPush(DUP_UUID, TARGET_UUID, '');
      expect(await service.completeFromPush(DUP_UUID, TARGET_UUID, '')).toEqual({ already: true });
      expect(erasure.requestErasure).toHaveBeenCalledTimes(1);
      expect(siteJobs.writeJobs).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(1);
    });

    it('writes the site jobs from the subjects the push names, for a row that captured none', async () => {
      const { service, siteJobs } = make({
        accounts: merged(),
        rows: [{ markedAt: new Date() }],
      });
      await service.completeFromPush(DUP_UUID, TARGET_UUID, '', {
        duplicateSubject: 'pushed-dup',
        targetSubject: 'pushed-target',
      });
      expect(siteJobs.writeJobs).toHaveBeenCalledWith(
        expect.anything(),
        'row-0',
        'pushed-dup',
        'pushed-target'
      );
      expect(log.error).not.toHaveBeenCalled();
    });

    it("keeps the row's captured subjects over the push's, and says so at error", async () => {
      const { service, siteJobs } = make({
        accounts: merged(),
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      await service.completeFromPush(DUP_UUID, TARGET_UUID, '', {
        duplicateSubject: 'forged-dup',
        targetSubject: 'sub-target',
      });
      expect(siteJobs.writeJobs).toHaveBeenCalledWith(
        expect.anything(),
        'row-0',
        'sub-duplicate',
        'sub-target'
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('duplicate subject differs from the one captured at the mark')
      );
    });

    it('cannot write jobs with no subject on the row nor in the push: an invariant broke, at error', async () => {
      const { service, rows, siteJobs } = make({
        accounts: merged(),
        rows: [{ markedAt: new Date() }],
      });
      await service.completeFromPush(DUP_UUID, TARGET_UUID, '');
      expect(rows[0].completedAt).not.toBeNull();
      expect(siteJobs.writeJobs).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('an invariant broke'));
    });

    it('decides MERGED from the proof, not markedAt: a request that died after the mark at MiConnect', async () => {
      // The process wrote the mark at MiConnect, then died before `markedAt`: the row is REQUESTED,
      // and MiConnect merged at the sign-in. The push completes it like any merge.
      const { service, rows, erasure, siteJobs } = make({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: null, ...subjects }],
      });
      expect(await service.completeFromPush(DUP_UUID, TARGET_UUID, 'row-0')).toEqual({
        completed: true,
      });
      expect(rows[0].completedBy).toBe('push');
      expect(erasure.requestErasure).toHaveBeenCalledWith('canari-dup');
      expect(siteJobs.writeJobs).toHaveBeenCalledTimes(1);
    });
  });

  describe('the reconciler (D54)', () => {
    it('completes with completedBy = reconciler, and says so at warning', async () => {
      const { service, rows, siteJobs } = make({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date(Date.now() - 30 * 60 * 1000), ...subjects }],
      });
      expect(await service.listOpenMerges()).toEqual([]);
      expect(rows[0].completedBy).toBe('reconciler');
      expect(siteJobs.writeJobs).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('[ALUMNI_MERGE] completed by the reconciler, not the push')
      );
    });

    it('decides MERGED from the proof as the push does: a requested row whose sign-in merged it', async () => {
      const { service, rows, erasure, siteJobs } = make({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: null, ...subjects }],
      });
      expect(await service.listOpenMerges()).toEqual([]);
      expect(rows[0].completedBy).toBe('reconciler');
      expect(erasure.requestErasure).toHaveBeenCalledWith('canari-dup');
      expect(siteJobs.writeJobs).toHaveBeenCalledTimes(1);
    });

    it('a "Rattacher" on a merged duplicate completes it from the proof, markedAt or not', async () => {
      const { service, rows, erasure } = make({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: null, ...subjects }],
      });
      await expect(service.merge(DUP_UUID, TARGET_UUID, 'admin-1')).rejects.toBeInstanceOf(
        AlumniMergeAlreadyMergedError
      );
      expect(rows[0].completedAt).not.toBeNull();
      expect(erasure.requestErasure).toHaveBeenCalledWith('canari-dup');
    });

    it('resolves the admin-queue flag of the duplicate in the closing transaction, by EVERY path that completes a merge', async () => {
      const closing = (): Parameters<typeof make>[0] => ({
        accounts: merged(),
        canari: { [DUP_UUID]: 'canari-dup' },
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      // The reconciler: a page reading finds the duplicate gone.
      const byReading = make(closing());
      await byReading.service.listOpenMerges();
      expect(byReading.flagsResolved).toEqual([DUP_UUID]);
      // MiConnect's push.
      const byPush = make(closing());
      await byPush.service.completeFromPush(DUP_UUID, TARGET_UUID, 'row-0');
      expect(byPush.flagsResolved).toEqual([DUP_UUID]);
      // A "Rattacher" over a duplicate MiConnect already merged.
      const byResume = make(closing());
      await expect(byResume.service.merge(DUP_UUID, TARGET_UUID, 'admin-1')).rejects.toBeInstanceOf(
        AlumniMergeAlreadyMergedError
      );
      expect(byResume.flagsResolved).toEqual([DUP_UUID]);
      // A row that left MiConnect unmarked and not merged is closed too: the duplicate is gone.
      const unmerged = make({ rows: [{ markedAt: null, ...subjects }] });
      await unmerged.service.listOpenMerges();
      expect(unmerged.flagsResolved).toEqual([DUP_UUID]);
      // A replayed completion closes nothing, so it resolves nothing.
      expect(byPush.rows[0].completedAt).not.toBeNull();
      await byPush.service.completeFromPush(DUP_UUID, TARGET_UUID, 'row-0');
      expect(byPush.flagsResolved).toEqual([DUP_UUID]);
    });

    it('a cancelled mark resolves no flag: the duplicate waits again', async () => {
      const { service, flagsResolved } = make({
        accounts: world(),
        rows: [{ markedAt: new Date(), ...subjects }],
      });
      await service.cancel(DUP_UUID, 'admin-1');
      expect(flagsResolved).toEqual([]);
    });

    it('lists a closed merge with its site states', async () => {
      const { service, siteJobs } = make({
        rows: [{ markedAt: new Date(), completedAt: new Date(), completedBy: 'push', ...subjects }],
      });
      siteJobs.statesOf.mockResolvedValue(
        new Map([
          [
            'row-0',
            [{ site: 'sky', state: 'done', outcome: 'absent', attempts: 0, lastError: null }],
          ],
        ])
      );
      expect(await service.listClosedMerges()).toEqual([
        expect.objectContaining({
          id: 'row-0',
          completedBy: 'push',
          sites: [expect.objectContaining({ site: 'sky', state: 'done' })],
        }),
      ]);
    });
  });

  describe('the manual merge (D55)', () => {
    /** A target the duplicate does not match by name: only an admin with a reason may attach it. */
    const OTHER_NAME = person({
      pk: 5,
      uuid: TARGET_UUID,
      uid: 'sub-target',
      username: 'c.martin',
      name: 'Camille MARTIN',
    });
    const manualWorld = () => ({
      [DUP_UUID]: { user: DUP, slugs: ['alumni'] },
      [TARGET_UUID]: { user: OTHER_NAME, slugs: ['cas-emse'] },
    });
    const REASON = 'Same person: her married name, confirmed by e-mail.';

    it('marks a manual merge with its reason and the two names the admin saw', async () => {
      holdingsAnswer();
      const { service, editor, rows } = make({ accounts: manualWorld() });
      const out = await service.merge(DUP_UUID, TARGET_UUID, 'admin-1', `  ${REASON}  `);
      expect(out.mode).toBe('manual');
      expect(rows[0]).toEqual(expect.objectContaining({ mode: 'manual', reason: REASON }));
      expect(editor.writeUser).toHaveBeenCalledWith(DUP_UUID, {
        attributes: expect.objectContaining({
          [MERGE_MARK.mode]: 'manual',
          [MERGE_MARK.id]: rows[0].id,
          [MERGE_MARK.seenAlumniName]: 'Camille Durand',
          [MERGE_MARK.seenTargetName]: 'Camille MARTIN',
        }),
      });
    });

    const refusals: [string, unknown, string][] = [
      ['no reason', undefined, 'missing'],
      ['a blank reason', '      ', 'missing'],
      ['a reason too short', 'too short', 'too_short'],
      ['a reason too long', 'x'.repeat(1001), 'too_long'],
    ];
    for (const [name, reason, why] of refusals) {
      it(`refuses ${name}, nothing written`, async () => {
        const { service, editor, rows } = make({ accounts: manualWorld() });
        const err = await service.merge(DUP_UUID, TARGET_UUID, 'a', reason).catch((e) => e);
        expect(err).toBeInstanceOf(AlumniMergeReasonRequiredError);
        expect((err as AlumniMergeReasonRequiredError).reason).toBe(why);
        expect(editor.writeUser).not.toHaveBeenCalled();
        expect(rows).toHaveLength(0);
      });
    }

    it('accepts a reason of exactly 20 and 1000 characters', async () => {
      holdingsAnswer();
      for (const reason of ['x'.repeat(20), 'x'.repeat(1000)]) {
        const { service } = make({ accounts: manualWorld() });
        await expect(service.merge(DUP_UUID, TARGET_UUID, 'a', reason)).resolves.toEqual(
          expect.objectContaining({ mode: 'manual' })
        );
      }
    });

    it('resumes an interrupted manual merge with no reason sent: the row keeps its own', async () => {
      const { service, editor, rows } = make({
        accounts: manualWorld(),
        rows: [{ mode: 'manual', reason: REASON }],
      });
      const out = await service.merge(DUP_UUID, TARGET_UUID, 'admin-1');
      expect(out.mode).toBe('manual');
      expect(rows[0]).toEqual(expect.objectContaining({ mode: 'manual', reason: REASON }));
      expect(rows[0].markedAt).not.toBeNull();
      expect(editor.writeUser).toHaveBeenCalledWith(DUP_UUID, {
        attributes: expect.objectContaining({
          [MERGE_MARK.mode]: 'manual',
          [MERGE_MARK.seenTargetName]: 'Camille MARTIN',
        }),
      });
    });

    it('refuses to resume an automatic merge whose target is no longer the unique match', async () => {
      const { service, editor, rows } = make({
        accounts: manualWorld(),
        rows: [{ mode: 'auto', reason: null }],
      });
      await expect(service.merge(DUP_UUID, TARGET_UUID, 'a', REASON)).rejects.toBeInstanceOf(
        AlumniMergeNoMatchError
      );
      expect(editor.writeUser).not.toHaveBeenCalled();
      expect(rows[0].markedAt).toBeNull();
    });

    it('refuses a busy target in a manual merge too', async () => {
      const { service, editor } = make({
        accounts: manualWorld(),
        rows: [{ duplicateUuid: HOMONYM_UUID, duplicateUsername: 'alumni-0003' }],
      });
      await expect(service.merge(DUP_UUID, TARGET_UUID, 'a', REASON)).rejects.toBeInstanceOf(
        AlumniMergeTargetBusyError
      );
      expect(editor.writeUser).not.toHaveBeenCalled();
    });

    const guards: [
      string,
      Record<string, { user: MiconnectUserListing; slugs: string[] }>,
      new (...a: never[]) => Error,
    ][] = [
      [
        'a superuser',
        { [TARGET_UUID]: { user: { ...OTHER_NAME, is_superuser: true }, slugs: ['cas-emse'] } },
        AlumniMergeNoMatchError,
      ],
      [
        'an inactive account',
        { [TARGET_UUID]: { user: { ...OTHER_NAME, is_active: false }, slugs: ['cas-emse'] } },
        AlumniMergeNoMatchError,
      ],
      [
        'a service account',
        {
          [TARGET_UUID]: { user: { ...OTHER_NAME, type: 'service_account' }, slugs: ['cas-emse'] },
        },
        AlumniMergeNoMatchError,
      ],
      [
        'an Alumni-created account',
        { [TARGET_UUID]: { user: { ...OTHER_NAME, username: 'alumni-77' }, slugs: ['cas-emse'] } },
        AlumniMergeNoMatchError,
      ],
      [
        'an account with no CAS link',
        { [TARGET_UUID]: { user: OTHER_NAME, slugs: [] } },
        AlumniMergeNoMatchError,
      ],
      [
        'an account already holding an Alumni link',
        { [TARGET_UUID]: { user: OTHER_NAME, slugs: ['cas-emse', 'alumni'] } },
        AlumniMergeNoMatchError,
      ],
      [
        'a duplicate that also holds a CAS link',
        { [DUP_UUID]: { user: DUP, slugs: ['alumni', 'cas-emse'] } },
        AlumniMergeNotDuplicateError,
      ],
    ];
    for (const [name, bend, error] of guards) {
      it(`refuses ${name} as a manual target, reason or not`, async () => {
        const { service, editor } = make({ accounts: { ...manualWorld(), ...bend } });
        await expect(service.merge(DUP_UUID, TARGET_UUID, 'a', REASON)).rejects.toBeInstanceOf(
          error
        );
        expect(editor.writeUser).not.toHaveBeenCalled();
      });
    }

    it('searches eligible targets only: no superuser, no Alumni-linked, no busy one', async () => {
      const su = person({
        pk: 6,
        uuid: '66666666-6666-4666-8666-666666666666',
        username: 'camille.su',
        name: 'Camille Su',
        is_superuser: true,
      });
      const linked = person({
        pk: 7,
        uuid: '77777777-7777-4777-8777-777777777777',
        username: 'camille.l',
        name: 'Camille L',
      });
      const busy = person({
        pk: 8,
        uuid: '88888888-8888-4888-8888-888888888888',
        username: 'camille.b',
        name: 'Camille B',
      });
      const { service } = make({
        accounts: {
          ...manualWorld(),
          [su.uuid]: { user: su, slugs: ['cas-emse'] },
          [linked.uuid]: { user: linked, slugs: ['cas-emse', 'alumni'] },
          [busy.uuid]: { user: busy, slugs: ['cas-emse'] },
        },
        rows: [{ duplicateUuid: HOMONYM_UUID, targetUuid: busy.uuid }],
      });
      const found = await service.eligibleTargets(DUP_UUID, 'camille');
      expect(found.map((t) => t.uuid)).toEqual([TARGET_UUID]);
      expect(await service.eligibleTargets(DUP_UUID, 'c')).toEqual([]);
    });

    // The search discloses e-mails and last sign-ins: never for an account that is not an Alumni
    // duplicate, whatever uuid the caller names.
    const notDuplicates: [
      string,
      Record<string, { user: MiconnectUserListing; slugs: string[] }>,
    ][] = [
      ['a CAS account', { [DUP_UUID]: { user: TARGET, slugs: ['cas-emse'] } }],
      [
        'an alumni- account holding another link',
        { [DUP_UUID]: { user: DUP, slugs: ['alumni', 'cas-emse'] } },
      ],
    ];
    for (const [name, accounts] of notDuplicates) {
      it(`refuses a target search for ${name}, nothing searched`, async () => {
        const { service, editor } = make({ accounts: { ...manualWorld(), ...accounts } });
        await expect(service.eligibleTargets(DUP_UUID, 'camille')).rejects.toBeInstanceOf(
          AlumniMergeNotDuplicateError
        );
        expect(editor.searchUsers).not.toHaveBeenCalled();
      });
    }
  });
});

describe('the reason bounds are the contract (D55, libs/contracts/alumni-merge-reason.json)', () => {
  const CONTRACT = JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'alumni-merge-reason.json'),
      'utf8'
    )
  ) as { min: number; max: number; cases: { text: string; problem: string | null }[] };

  it('holds the contract bounds', () => {
    expect([ALUMNI_MERGE_REASON_MIN, ALUMNI_MERGE_REASON_MAX]).toEqual([
      CONTRACT.min,
      CONTRACT.max,
    ]);
  });

  it.each(CONTRACT.cases)('counts %j in code points, as the page does', ({ text, problem }) => {
    const verdict = (() => {
      try {
        checkMergeReason(text, 'manual');
        return null;
      } catch (err) {
        return (err as AlumniMergeReasonRequiredError).reason;
      }
    })();
    // The empty text is `missing` here (a manual merge owes one); the page calls it too short.
    expect(verdict === 'missing' ? 'too_short' : verdict).toBe(problem);
  });

  it('counts an emoji once at the upper bound', () => {
    expect(checkMergeReason('\u{1F600}'.repeat(CONTRACT.max), 'manual')).toHaveLength(
      2 * CONTRACT.max
    );
    expect(() => checkMergeReason('\u{1F600}'.repeat(CONTRACT.max + 1), 'manual')).toThrow(
      AlumniMergeReasonRequiredError
    );
  });
});
