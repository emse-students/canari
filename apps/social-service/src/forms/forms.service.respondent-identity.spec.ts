import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { FORM_GUEST_IDENTITY_MISSING, FORM_GUEST_IDENTITY_NOT_ASKED } from './answer-bounds';
import type { ExportLabels } from './export-labels';
import { FormsService } from './forms.service';
import { legacyGuestFieldsMerge, storedGuestFields } from './guest-identity';
import {
  accountSnapshot,
  accountStatuses,
  declaredIdentityFor,
  identityColumnsOf,
  joinedAccountFields,
  storedRespondentFields,
  type AccountIdentity,
} from './respondent-identity';

/**
 * THE RESPONDENT'S ACCOUNT FIELDS A FORM JOINS TO EACH ANSWER (owner, 2026-11-16).
 *
 * Per form, the organiser ticks which of the names, the promo and formation, the student / staff
 * status and the campus travel with each answer. A member of a named form has them read from the
 * ACCOUNT at submit time - never from the request - and stored as a snapshot; whoever the form
 * cannot read from an account (a guest, an anonymous form) is ASKED instead. The organiser reads
 * them as columns of the export.
 */
describe('the respondent account fields of a form', () => {
  /** A build that draws the declared questions (`RESPONDENT_FIELDS_MIN_CLIENT_VERSION`). */
  const CURRENT = '1.7.0';
  const ACCOUNT: AccountIdentity = {
    firstName: 'Marie',
    lastName: 'CURIE',
    campus: 'gardanne',
    posts: ['EMSE'],
    cursusViews: [
      { promo: 2024, formation: 'ISMIN' },
      { promo: 2022, formation: 'Autre' },
    ],
  };

  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: 'u-owner',
    associationId: null,
    title: 'Soiree',
    description: '',
    imageUrl: null,
    isPublic: false,
    anonymous: false,
    requiresPayment: false,
    currency: 'eur',
    basePrice: 0,
    allowMultipleSubmissions: true,
    maxSubmissions: null,
    opensAt: null,
    closedAt: null,
    priceMatrix: null,
    submitCondition: null,
    guestFields: null,
    respondentFields: ['lastName', 'firstName'],
    items: [{ id: 'q1', label: 'Menu', required: false, type: 'short_text' }],
    ...over,
  });

  function makeService(form: Record<string, unknown>) {
    const saved: Record<string, unknown>[] = [];
    const manager: any = {
      query: jest.fn(() => Promise.resolve([{ formId: 'f1' }])),
      create: jest.fn((_entity: unknown, row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve({ id: 's1', ...row });
      }),
      count: jest.fn(() => Promise.resolve(0)),
    };
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve(form)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
    };
    const submissionRepo: any = {
      count: jest.fn(() => Promise.resolve(0)),
      manager: { transaction: jest.fn((_l: string, fn: any) => fn(manager)) },
    };
    const accountIdentity = jest.fn(() => Promise.resolve(ACCOUNT));
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      {
        isMember: jest.fn(() => Promise.resolve(true)),
        collectsNow: jest.fn(() => Promise.resolve(true)),
      } as any,
      {} as any,
      {} as any,
      {
        build: jest.fn(() =>
          Promise.resolve({
            cursus: [{ promo: null, formation: null }],
            cotisationTiers: [],
            answers: {},
          })
        ),
        accountIdentity,
      } as any,
      { count: jest.fn() } as any,
      {} as any,
      { enabled: () => false } as any,
      {} as any
    );
    return { service, saved, formRepo, accountIdentity };
  }

  const code = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return ((e as BadRequestException).getResponse() as { code?: string }).code;
    }
    throw new Error('expected a refusal');
  };

  describe('the rule', () => {
    it('joins nothing from an account on an anonymous form, and stores it so', () => {
      expect(joinedAccountFields({ anonymous: true, respondentFields: ['lastName'] })).toEqual([]);
      expect(
        joinedAccountFields({ anonymous: false, respondentFields: ['campus', 'lastName'] })
      ).toEqual(['lastName', 'campus']);
      expect(storedRespondentFields(['cursus'], true)).toEqual([]);
      expect(storedRespondentFields(['status', 'nickname'], false)).toEqual(['status']);
    });

    it('reads a student from a cursus and staff from a post, both at once when both', () => {
      expect(accountStatuses(ACCOUNT)).toEqual(['student', 'staff']);
      expect(accountStatuses({ ...ACCOUNT, posts: [] })).toEqual(['student']);
      expect(accountStatuses({ ...ACCOUNT, cursusViews: [] })).toEqual(['staff']);
    });

    it('snapshots only the joined fields, every cursus included', () => {
      expect(accountSnapshot(['lastName', 'cursus'], ACCOUNT)).toEqual({
        source: 'account',
        lastName: 'CURIE',
        cursus: [
          { promo: 2024, formation: 'ISMIN' },
          { promo: 2022, formation: 'Autre' },
        ],
      });
      expect(accountSnapshot([], null)).toEqual({ source: 'account' });
    });

    it('requires every declared field asked, refuses one not asked, and takes "none" for staff', () => {
      expect(() => declaredIdentityFor(['status'], {}, 'f1')).toThrow(BadRequestException);
      expect(() => declaredIdentityFor([], { declaredCampus: 'gardanne' }, 'f1')).toThrow(
        BadRequestException
      );
      expect(() => declaredIdentityFor(['cursus'], { declaredFormation: 'ICM' }, 'f1')).toThrow(
        BadRequestException
      );
      expect(() => declaredIdentityFor(['campus'], { declaredCampus: 'paris' }, 'f1')).toThrow(
        BadRequestException
      );
      expect(
        declaredIdentityFor(
          ['cursus', 'status', 'campus'],
          {
            declaredFormation: 'ICM',
            declaredPromo: 2024,
            declaredStatus: 'student',
            declaredCampus: 'saint-etienne',
          },
          'f1'
        )
      ).toEqual({
        source: 'declared',
        cursus: [{ promo: 2024, formation: 'ICM' }],
        status: ['student'],
        campus: 'saint-etienne',
      });
      expect(declaredIdentityFor(['cursus'], { declaredFormation: 'none' }, 'f1')).toEqual({
        source: 'declared',
        cursus: [],
      });
      expect(declaredIdentityFor([], {}, 'f1')).toBeNull();
    });

    it('stores the declared asks beside the guest ones, and an older editor keeps them', () => {
      expect(storedGuestFields(['campus', 'email', 'cursus'])).toEqual([
        'email',
        'cursus',
        'campus',
      ]);
      // An editor older than the account fields knows names and e-mail only: its list replaces
      // those, never the declared asks it could not show.
      expect(legacyGuestFieldsMerge(['lastName'], ['email', 'status'])).toEqual([
        'lastName',
        'status',
      ]);
      expect(legacyGuestFieldsMerge([], null)).toBeNull();
    });
  });

  describe('a member of a named form', () => {
    it('stores the joined fields read from the ACCOUNT at submit time', async () => {
      const { service, saved, accountIdentity } = makeService(
        baseForm({ respondentFields: ['lastName', 'firstName', 'cursus', 'status', 'campus'] })
      );
      await service.submit('f1', { answers: { q1: 'vege' }, userId: 'u1' }, 'member');
      expect(accountIdentity).toHaveBeenCalledWith('u1');
      expect(saved[0].respondentIdentity).toEqual({
        source: 'account',
        lastName: 'CURIE',
        firstName: 'Marie',
        cursus: [
          { promo: 2024, formation: 'ISMIN' },
          { promo: 2022, formation: 'Autre' },
        ],
        status: ['student', 'staff'],
        campus: 'gardanne',
      });
    });

    it('refuses a declared field from the request: the account is the only source', async () => {
      const { service, saved } = makeService(baseForm({ respondentFields: ['cursus'] }));
      expect(
        await code(
          service.submit(
            'f1',
            { answers: {}, userId: 'u1', declaredFormation: 'ICM', declaredPromo: 2020 },
            'member'
          )
        )
      ).toBe(FORM_GUEST_IDENTITY_NOT_ASKED);
      expect(saved).toHaveLength(0);
    });

    it('reads nothing from core-service when the form joins nothing', async () => {
      const { service, saved, accountIdentity } = makeService(baseForm({ respondentFields: [] }));
      await service.submit('f1', { answers: {}, userId: 'u1' }, 'member');
      expect(accountIdentity).not.toHaveBeenCalled();
      expect(saved[0].respondentIdentity).toEqual({ source: 'account' });
    });
  });

  describe('a respondent the form cannot read from an account is ASKED instead', () => {
    it('asks a member of an anonymous form, and stores what they declared, with no account', async () => {
      const { service, saved, accountIdentity } = makeService(
        baseForm({ anonymous: true, guestFields: ['status'], respondentFields: [] })
      );
      expect(
        await code(
          service.submit('f1', { answers: {}, userId: 'u1', clientVersion: CURRENT }, 'member')
        )
      ).toBe(FORM_GUEST_IDENTITY_MISSING);
      await service.submit(
        'f1',
        { answers: {}, userId: 'u1', declaredStatus: 'staff', clientVersion: CURRENT },
        'member'
      );
      expect(accountIdentity).not.toHaveBeenCalled();
      expect(saved[0]).toMatchObject({
        userId: null,
        respondentIdentity: { source: 'declared', status: ['staff'] },
      });
    });

    it('takes an older client\'s answer without the declared fields, marked "not declared"', async () => {
      // A store build older than the account fields cannot draw the questions: its ordinary
      // answer is taken, and the organiser sees which fields it could not declare.
      for (const clientVersion of [undefined, '1.6.12']) {
        const { service, saved } = makeService(
          baseForm({ anonymous: true, guestFields: ['cursus', 'status'], respondentFields: [] })
        );
        await service.submit('f1', { answers: {}, userId: 'u1', clientVersion }, 'member');
        expect(saved[0]).toMatchObject({
          userId: null,
          respondentIdentity: { source: 'declared', notDeclared: ['cursus', 'status'] },
        });
      }
    });

    it('still judges what an older client does send', async () => {
      const { service } = makeService(
        baseForm({ anonymous: true, guestFields: ['status'], respondentFields: [] })
      );
      expect(
        await code(
          service.submit('f1', { answers: {}, userId: 'u1', declaredStatus: 'boss' }, 'member')
        )
      ).toBe(FORM_GUEST_IDENTITY_MISSING);
    });

    it('asks a guest of a public form the declared fields, beside the names', async () => {
      const { service, saved, accountIdentity } = makeService(
        baseForm({ isPublic: true, guestFields: ['lastName', 'campus'] })
      );
      expect(
        await code(
          service.submit(
            'f1',
            { answers: {}, guestLastName: 'Curie', clientVersion: CURRENT },
            'guest'
          )
        )
      ).toBe(FORM_GUEST_IDENTITY_MISSING);
      await service.submit(
        'f1',
        { answers: {}, guestLastName: 'Curie', declaredCampus: 'gardanne', clientVersion: CURRENT },
        'guest'
      );
      expect(accountIdentity).not.toHaveBeenCalled();
      expect(saved[0]).toMatchObject({
        userId: null,
        guestLastName: 'Curie',
        respondentIdentity: { source: 'declared', campus: 'gardanne' },
      });
    });
  });

  describe('the form settings', () => {
    it('joins the two names by default on a create, and nothing on an anonymous one', async () => {
      const { service, formRepo } = makeService(baseForm());
      formRepo.findOne = jest.fn(() => Promise.resolve(null));
      const base = { title: 'T', items: [], ownerId: 'u-owner', draft: true } as any;
      await service.create({ ...base }, false);
      expect(formRepo.save.mock.calls[0][0].respondentFields).toEqual(['lastName', 'firstName']);
      await service.create({ ...base, anonymous: true, respondentFields: ['campus'] }, false);
      expect(formRepo.save.mock.calls[1][0].respondentFields).toEqual([]);
    });
  });

  describe('the export', () => {
    const LABELS: ExportLabels = {
      date: 'Date',
      firstName: 'Prenom',
      lastName: 'Nom',
      amount: 'Montant',
      status: 'Statut paiement',
      statuses: { free: 'Gratuit' },
      guest: 'Invite',
      identity: {
        promo: 'Promo',
        formation: 'Formation',
        status: 'Statut',
        campus: 'Campus',
        student: 'Eleve',
        staff: 'Personnel',
        campuses: { gardanne: 'Gardanne', 'saint-etienne': 'Saint-Etienne' },
        notDeclared: 'Non declare',
      },
    };

    function exporter(form: Record<string, unknown>, submissions: Record<string, unknown>[]) {
      const query = jest.fn(() =>
        Promise.resolve([{ id: 'u-old', firstName: 'Ada', lastName: 'LOVELACE' }])
      );
      const service = new FormsService(
        {
          findOne: jest.fn(() => Promise.resolve(form)),
          manager: { query },
        } as any,
        { find: jest.fn(() => Promise.resolve(submissions)) } as any,
        {} as any,
        { get: jest.fn() } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { enabled: () => false } as any,
        {} as any
      );
      return { service, query };
    }

    async function rows(service: FormsService, labels = LABELS): Promise<string[][]> {
      const { buffer } = await service.exportSubmissions('f1', labels);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const out: string[][] = [];
      workbook.worksheets[0].eachRow((row) => {
        out.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v))));
      });
      return out;
    }

    const sub = (over: Record<string, unknown>) => ({
      id: 's1',
      userId: 'u1',
      answers: { q1: 'vege' },
      totalPaid: 0,
      paymentStatus: 'free',
      createdAt: new Date(2026, 10, 16, 12, 0),
      ...over,
    });

    it('writes the snapshot as columns, in the words the client sent', async () => {
      const { service, query } = exporter(
        baseForm({ respondentFields: ['lastName', 'firstName', 'cursus', 'status', 'campus'] }),
        [
          sub({
            respondentIdentity: {
              source: 'account',
              lastName: 'CURIE',
              firstName: 'Marie',
              cursus: [
                { promo: 2024, formation: 'ISMIN' },
                { promo: 2022, formation: 'Autre' },
              ],
              status: ['student', 'staff'],
              campus: 'gardanne',
            },
          }),
        ]
      );
      const [header, row] = await rows(service);
      expect(header).toEqual([
        'Date',
        'Prenom',
        'Nom',
        'Promo',
        'Formation',
        'Statut',
        'Campus',
        'Menu',
      ]);
      expect(row.slice(1)).toEqual([
        'Marie',
        'CURIE',
        '2024; 2022',
        'ISMIN; Autre',
        'Eleve; Personnel',
        'Gardanne',
        'vege',
      ]);
      // A snapshot is the answer's name: the account is not read again.
      expect(query).not.toHaveBeenCalled();
    });

    it("reads an answer given before the snapshot by the account's name, as it always was", async () => {
      const { service, query } = exporter(baseForm(), [
        sub({ id: 's-old', userId: 'u-old', respondentIdentity: null }),
        sub({ id: 's-new', userId: 'u1', respondentIdentity: { source: 'account' } }),
      ]);
      const [header, older, newer] = await rows(service);
      expect(header).toEqual(['Date', 'Prenom', 'Nom', 'Menu']);
      expect(older.slice(1, 3)).toEqual(['Ada', 'LOVELACE']);
      // The form stopped joining the names: the newer answer carries none.
      expect(newer.slice(1, 3)).toEqual(['', '']);
      expect(query).toHaveBeenCalledWith(expect.any(String), [['u-old']]);
    });

    it('writes the columns in the default words for a client older than the account fields', async () => {
      // An organiser on a store build older than this release sends no identity words: the
      // export is still served ([LEGACY], `docs/wiki/legacy-compatibility.md`), never refused.
      const { service } = exporter(baseForm({ respondentFields: ['campus', 'status'] }), [
        sub({ respondentIdentity: { source: 'account', status: ['staff'], campus: 'gardanne' } }),
      ]);
      const { identity: _identity, ...older } = LABELS;
      const [header, row] = await rows(service, older);
      expect(header).toEqual([
        'Date',
        'Prenom',
        'Nom',
        'Statut élève / personnel',
        'Campus',
        'Menu',
      ]);
      expect(row.slice(3, 5)).toEqual(['Personnel', 'Gardanne']);
    });

    it('writes "not declared" for a field an older client could not send', async () => {
      const { service } = exporter(
        baseForm({ anonymous: true, guestFields: ['cursus', 'status'], respondentFields: [] }),
        [
          sub({
            userId: null,
            respondentIdentity: { source: 'declared', notDeclared: ['cursus', 'status'] },
          }),
        ]
      );
      const [header, row] = await rows(service);
      expect(header).toEqual(['Date', 'Promo', 'Formation', 'Statut', 'Menu']);
      expect(row.slice(1, 4)).toEqual(['Non declare', 'Non declare', 'Non declare']);
    });

    it('draws a column only for a field joined, asked, or carried by an answer', () => {
      expect(
        identityColumnsOf(baseForm(), [
          { respondentIdentity: { source: 'declared', notDeclared: ['status'] } },
        ])
      ).toEqual(['status']);
      expect(identityColumnsOf(baseForm(), [])).toEqual([]);
      expect(identityColumnsOf(baseForm({ anonymous: true, guestFields: ['status'] }), [])).toEqual(
        ['status']
      );
      expect(
        identityColumnsOf(baseForm(), [
          { respondentIdentity: { source: 'account', campus: 'gardanne' } },
        ])
      ).toEqual(['campus']);
    });
  });
});
