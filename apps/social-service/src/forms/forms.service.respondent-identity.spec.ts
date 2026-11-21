import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { SubmitFormDto } from './dto/form.dto';
import * as ExcelJS from 'exceljs';
import {
  FORM_GUEST_IDENTITY_MISSING,
  FORM_GUEST_IDENTITY_NOT_ASKED,
  FORM_RESPONDENT_FIELDS_CHANGED,
} from './answer-bounds';
import type { ExportLabels } from './export-labels';
import { FormsService } from './forms.service';
import { legacyGuestFieldsMerge, storedGuestFields } from './guest-identity';
import {
  accountSnapshot,
  accountStatuses,
  announcedMatchesJoined,
  askedOfMember,
  declaredIdentityFor,
  identityColumnsOf,
  joinedAccountFields,
  joinsBeyondCursus,
  storedRespondentFields,
  type AccountIdentity,
} from './respondent-identity';
import { cursusSourceOf, showsCursusSource } from './respondent-source';

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
    // The shared `users` table, as social-service reads it (same database as core-service).
    const usersQuery = jest.fn((_sql: string, _params: unknown[]) =>
      Promise.resolve([{ firstName: 'Marie', lastName: 'CURIE', campus: 'gardanne' }])
    );
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve(form)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
      manager: { query: usersQuery },
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
    return { service, saved, formRepo, accountIdentity, usersQuery };
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
    it('joins at most the cursus from an account on an anonymous form, and stores it so', () => {
      expect(joinedAccountFields({ anonymous: true, respondentFields: ['lastName'] })).toEqual([]);
      expect(
        joinedAccountFields({ anonymous: true, respondentFields: ['campus', 'cursus', 'status'] })
      ).toEqual(['cursus']);
      expect(storedRespondentFields(['cursus', 'lastName'], true)).toEqual(['cursus']);
      expect(joinsBeyondCursus(['cursus'])).toBe(false);
      expect(joinsBeyondCursus([])).toBe(false);
      expect(joinsBeyondCursus(undefined)).toBe(false);
      expect(joinsBeyondCursus(['cursus', 'campus'])).toBe(true);
      // One field, one source: a member is not asked the cursus the form reads from the account.
      expect(
        askedOfMember({ guestFields: ['cursus', 'status'], respondentFields: ['cursus'] })
      ).toEqual(['status']);
      expect(askedOfMember({ guestFields: ['cursus', 'status'], respondentFields: [] })).toEqual([
        'cursus',
        'status',
      ]);
      expect(
        joinedAccountFields({ anonymous: false, respondentFields: ['campus', 'lastName'] })
      ).toEqual(['lastName', 'campus']);
      expect(storedRespondentFields(['campus'], true)).toEqual([]);
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

    it('submits a default named form with core-service unreachable: the names come from the shared table', async () => {
      const { service, saved, accountIdentity, usersQuery } = makeService(baseForm());
      accountIdentity.mockImplementation(() => Promise.reject(new Error('core-service is down')));
      await service.submit('f1', { answers: { q1: 'vege' }, userId: 'u1' }, 'member');
      expect(accountIdentity).not.toHaveBeenCalled();
      expect(usersQuery).toHaveBeenCalledWith(expect.stringContaining('FROM users'), ['u1']);
      expect(saved[0].respondentIdentity).toEqual({
        source: 'account',
        lastName: 'CURIE',
        firstName: 'Marie',
      });
    });

    it('reads the campus from the shared table too, and reaches core-service only for a cursus or a status', async () => {
      const campus = makeService(baseForm({ respondentFields: ['firstName', 'campus'] }));
      campus.accountIdentity.mockImplementation(() => Promise.reject(new Error('down')));
      await campus.service.submit('f1', { answers: {}, userId: 'u1' }, 'member');
      expect(campus.accountIdentity).not.toHaveBeenCalled();
      expect(campus.saved[0].respondentIdentity).toEqual({
        source: 'account',
        firstName: 'Marie',
        campus: 'gardanne',
      });
      for (const field of ['cursus', 'status']) {
        const core = makeService(baseForm({ respondentFields: ['lastName', field] }));
        await core.service.submit('f1', { answers: {}, userId: 'u1' }, 'member');
        expect(core.accountIdentity).toHaveBeenCalledWith('u1');
        expect(core.usersQuery).not.toHaveBeenCalled();
      }
    });

    it('joins nothing, accused, for an account the shared table does not hold', async () => {
      const { service, saved, usersQuery } = makeService(baseForm());
      usersQuery.mockImplementation(() => Promise.resolve([]));
      await service.submit('f1', { answers: {}, userId: 'u1' }, 'member');
      expect(saved[0].respondentIdentity).toEqual({
        source: 'account',
        lastName: null,
        firstName: null,
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
      await service.create({ ...base, anonymous: true }, false);
      expect(formRepo.save.mock.calls[1][0].respondentFields).toEqual([]);
      await service.create(
        { ...base, anonymous: true, respondentFields: ['cursus'], guestFields: ['cursus'] },
        false
      );
      expect(formRepo.save.mock.calls[2][0].respondentFields).toEqual(['cursus']);
    });

    it('refuses an anonymous form that joins the cursus without asking it, by its typed code', async () => {
      const { service, formRepo } = makeService(baseForm());
      formRepo.findOne = jest.fn(() => Promise.resolve(null));
      const base = {
        title: 'T',
        items: [],
        ownerId: 'u-owner',
        draft: true,
        anonymous: true,
      } as any;
      expect(
        await code(
          service.create({ ...base, respondentFields: ['cursus'], guestFields: ['status'] }, false)
        )
      ).toBe('FORM_ANONYMOUS_CURSUS_NOT_ASKED');
      expect(formRepo.save).not.toHaveBeenCalled();
      await service.create(
        { ...base, respondentFields: ['cursus'], guestFields: ['cursus'] },
        false
      );
      expect(formRepo.save).toHaveBeenCalledTimes(1);
    });

    describe('an edit of a draft', () => {
      const draft = (over: Record<string, unknown> = {}) =>
        baseForm({
          status: 'draft',
          anonymous: false,
          respondentFields: ['lastName', 'cursus'],
          guestFields: ['cursus'],
          ...over,
        });
      const edit = (over: Record<string, unknown> = {}) =>
        ({ title: 'T', items: [], ownerId: 'u-owner', ...over }) as any;
      const asManager = (service: FormsService, form: unknown) =>
        jest.spyOn(service, 'assertFormManager').mockResolvedValue(form as any);

      it('stores no join when it turns anonymous and sends no respondentFields (a named draft held the cursus)', async () => {
        const form = draft();
        const { service, formRepo } = makeService(form);
        asManager(service, form);
        await service.update('f1', edit({ anonymous: true }), 'u-owner', false);
        expect(formRepo.save.mock.calls[0][0].respondentFields).toEqual([]);
        // Nothing sent, nothing changed in anonymity: the stored join is kept as it was.
        const kept = draft({ anonymous: true, respondentFields: ['cursus'] });
        const second = makeService(kept);
        asManager(second.service, kept);
        await second.service.update('f1', edit(), 'u-owner', false);
        expect(second.formRepo.save.mock.calls[0][0].respondentFields).toEqual(['cursus']);
      });

      it('stores no join when a joining anonymous draft goes back to named without respondentFields', async () => {
        const form = draft({ anonymous: true, respondentFields: ['cursus'] });
        const { service, formRepo } = makeService(form);
        asManager(service, form);
        await service.update('f1', edit({ anonymous: false }), 'u-owner', false);
        expect(formRepo.save.mock.calls[0][0].respondentFields).toEqual([]);
      });

      it('refuses, by the same typed codes, an anonymous form that joins what it may not', async () => {
        const form = draft({ anonymous: true, respondentFields: [] });
        const { service, formRepo } = makeService(form);
        asManager(service, form);
        expect(
          await code(
            service.update('f1', edit({ respondentFields: ['cursus', 'status'] }), 'u-owner', false)
          )
        ).toBe('FORM_ANONYMOUS_ACCOUNT_FIELDS');
        expect(
          await code(
            service.update(
              'f1',
              edit({ respondentFields: ['cursus'], guestFields: ['status'] }),
              'u-owner',
              false
            )
          )
        ).toBe('FORM_ANONYMOUS_CURSUS_NOT_ASKED');
        expect(formRepo.save).not.toHaveBeenCalled();
      });
    });

    it('refuses an anonymous form that joins a name, a status or a campus, by its typed code', async () => {
      const { service, formRepo } = makeService(baseForm());
      formRepo.findOne = jest.fn(() => Promise.resolve(null));
      const base = {
        title: 'T',
        items: [],
        ownerId: 'u-owner',
        draft: true,
        anonymous: true,
      } as any;
      for (const field of ['lastName', 'firstName', 'status', 'campus']) {
        expect(
          await code(service.create({ ...base, respondentFields: ['cursus', field] }, false))
        ).toBe('FORM_ANONYMOUS_ACCOUNT_FIELDS');
      }
      expect(formRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('an anonymous form that reads the cursus from the account (owner, 2026-11-21)', () => {
    /** A build that announces the join (`ANONYMOUS_CURSUS_JOIN_MIN_CLIENT_VERSION`). */
    const ANNOUNCING = '1.7.3';
    const joining = (over: Record<string, unknown> = {}) =>
      baseForm({ anonymous: true, guestFields: ['cursus'], respondentFields: ['cursus'], ...over });
    /** How many transactions the submit opened (the seat lock and the registry live inside). */
    const manager = (service: FormsService): number =>
      ((service as any).submissionRepo.manager.transaction as jest.Mock).mock.calls.length;
    const CURSUS = [
      { promo: 2024, formation: 'ISMIN' },
      { promo: 2022, formation: 'Autre' },
    ];

    it('reads the cursus of a member from the account, snapshot "account", nobody named', async () => {
      const { service, saved, accountIdentity } = makeService(joining());
      await service.submit(
        'f1',
        { answers: {}, userId: 'u1', clientVersion: ANNOUNCING, announcedFields: ['cursus'] },
        'member'
      );
      expect(accountIdentity).toHaveBeenCalledWith('u1', { anonymous: true });
      expect(saved[0]).toMatchObject({
        userId: null,
        respondentIdentity: { source: 'account', cursus: CURSUS },
      });
      const identity = saved[0].respondentIdentity as Record<string, unknown>;
      expect(Object.keys(identity).sort()).toEqual(['cursus', 'source']);
    });

    it('marks which key came from the account when the rest is declared', async () => {
      const { service, saved } = makeService(
        joining({ guestFields: ['cursus', 'status', 'campus'] })
      );
      expect(
        await code(
          service.submit(
            'f1',
            { answers: {}, userId: 'u1', clientVersion: ANNOUNCING, announcedFields: ['cursus'] },
            'member'
          )
        )
      ).toBe(FORM_GUEST_IDENTITY_MISSING);
      await service.submit(
        'f1',
        {
          answers: {},
          userId: 'u1',
          declaredStatus: 'staff',
          declaredCampus: 'gardanne',
          clientVersion: ANNOUNCING,
          announcedFields: ['cursus'],
        },
        'member'
      );
      expect(saved[0].respondentIdentity).toEqual({
        source: 'declared',
        status: ['staff'],
        campus: 'gardanne',
        cursus: CURSUS,
        fromAccount: ['cursus'],
      });
    });

    it('refuses a declared cursus from a member: one field, one source', async () => {
      const { service, saved } = makeService(joining());
      expect(
        await code(
          service.submit(
            'f1',
            {
              answers: {},
              userId: 'u1',
              declaredFormation: 'ICM',
              declaredPromo: 2020,
              clientVersion: ANNOUNCING,
              announcedFields: ['cursus'],
            },
            'member'
          )
        )
      ).toBe(FORM_GUEST_IDENTITY_NOT_ASKED);
      expect(saved).toHaveLength(0);
    });

    it('asks a guest the cursus, declared, and reads no account', async () => {
      const { service, saved, accountIdentity } = makeService(joining({ isPublic: true }));
      expect(
        await code(
          service.submit(
            'f1',
            { answers: {}, clientVersion: ANNOUNCING, announcedFields: ['cursus'] },
            'guest'
          )
        )
      ).toBe(FORM_GUEST_IDENTITY_MISSING);
      await service.submit(
        'f1',
        {
          answers: {},
          declaredFormation: 'ICM',
          declaredPromo: 2020,
          clientVersion: ANNOUNCING,
          announcedFields: ['cursus'],
        },
        'guest'
      );
      expect(accountIdentity).not.toHaveBeenCalled();
      expect(saved[0].respondentIdentity).toEqual({
        source: 'declared',
        cursus: [{ promo: 2020, formation: 'ICM' }],
      });
    });

    it('fails closed when core-service is down: 503, no answer and no registry row', async () => {
      const { service, saved, accountIdentity } = makeService(joining());
      accountIdentity.mockRejectedValueOnce(new ServiceUnavailableException('core-service down'));
      await expect(
        service.submit(
          'f1',
          { answers: {}, userId: 'u1', clientVersion: ANNOUNCING, announcedFields: ['cursus'] },
          'member'
        )
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(saved).toHaveLength(0);
      // The seat lock and the registry are statements of the transaction: it never opened.
      expect(manager(service)).toBe(0);
    });

    describe('a member is joined only to what their page announced (principle 1)', () => {
      const asMember = (over: Record<string, unknown> = {}) => ({
        answers: {},
        userId: 'u1',
        clientVersion: ANNOUNCING,
        ...over,
      });

      it('refuses a form that began joining the cursus after the page loaded, then accepts the reload', async () => {
        const { service, saved, accountIdentity, formRepo } = makeService(joining());
        // The page loaded while the form joined nothing: it announced [].
        expect(await code(service.submit('f1', asMember({ announcedFields: [] }), 'member'))).toBe(
          FORM_RESPONDENT_FIELDS_CHANGED
        );
        expect(saved).toHaveLength(0);
        expect(accountIdentity).not.toHaveBeenCalled();
        // The page read the form again (its notice now names the cursus) and sends again.
        expect(formRepo.findOne).toHaveBeenCalled();
        await service.submit('f1', asMember({ announcedFields: ['cursus'] }), 'member');
        expect(saved[0].respondentIdentity).toMatchObject({ source: 'account' });
      });

      it('refuses a named form whose joined fields changed, in either direction', async () => {
        const { service, saved } = makeService(
          baseForm({ respondentFields: ['lastName', 'campus'] })
        );
        for (const announcedFields of [['lastName'], ['lastName', 'firstName', 'campus'], []]) {
          expect(await code(service.submit('f1', asMember({ announcedFields }), 'member'))).toBe(
            FORM_RESPONDENT_FIELDS_CHANGED
          );
        }
        expect(saved).toHaveLength(0);
        await service.submit('f1', asMember({ announcedFields: ['campus', 'lastName'] }), 'member');
        expect(saved).toHaveLength(1);
      });

      it('humours a named form from a build announcing nothing, [LEGACY]', async () => {
        const { service, saved } = makeService(baseForm());
        await service.submit('f1', asMember(), 'member');
        expect(saved[0].respondentIdentity).toMatchObject({ source: 'account' });
      });

      it('compares canonically', () => {
        expect(announcedMatchesJoined(['campus', 'lastName'], ['lastName', 'campus'])).toBe(true);
        expect(announcedMatchesJoined([], [])).toBe(true);
        expect(announcedMatchesJoined(['cursus'], [])).toBe(false);
      });
    });

    it('says where each cursus came from once an anonymous form holds a certified one', () => {
      const account = { source: 'account', cursus: CURSUS } as const;
      const mixed = {
        source: 'declared',
        status: ['staff'],
        cursus: CURSUS,
        fromAccount: ['cursus'],
      } as const;
      const declared = { source: 'declared', cursus: [{ promo: 2020, formation: 'ICM' }] } as const;
      expect(cursusSourceOf(account as any)).toBe('account');
      expect(cursusSourceOf(mixed as any)).toBe('account');
      expect(cursusSourceOf(declared as any)).toBe('declared');
      expect(cursusSourceOf({ source: 'declared', campus: 'gardanne' } as any)).toBeNull();
      expect(cursusSourceOf(null)).toBeNull();
      const rows = [{ respondentIdentity: declared as any }];
      expect(showsCursusSource({ anonymous: true }, rows)).toBe(false);
      expect(
        showsCursusSource({ anonymous: true }, [...rows, { respondentIdentity: account as any }])
      ).toBe(true);
      // A named form never mixes in this column: its own columns stay as they were.
      expect(
        showsCursusSource({ anonymous: false }, [{ respondentIdentity: account as any }])
      ).toBe(false);
    });

    it('never joins an anonymous form for a new build that announces nothing: it is asked', async () => {
      const { service, saved, accountIdentity } = makeService(joining());
      await service.submit(
        'f1',
        {
          answers: {},
          userId: 'u1',
          clientVersion: ANNOUNCING,
          declaredPromo: 2020,
          declaredFormation: 'ICM',
        },
        'member'
      );
      expect(accountIdentity).not.toHaveBeenCalled();
      expect(saved[0].respondentIdentity).toMatchObject({ source: 'declared' });
    });

    it('keeps announcedFields through the real ValidationPipe whitelist', async () => {
      const pipe = new ValidationPipe({ whitelist: true, transform: true });
      const dto = await pipe.transform(
        { answers: {}, announcedFields: ['cursus'] },
        { type: 'body', metatype: SubmitFormDto }
      );
      expect(dto.announcedFields).toEqual(['cursus']);
      await expect(
        pipe.transform(
          { answers: {}, announcedFields: [1] },
          { type: 'body', metatype: SubmitFormDto }
        )
      ).rejects.toThrow(BadRequestException);
    });

    describe('no log line pairs a person with the anonymous form', () => {
      const FORM = 'f1-DISTINCTIVE-form-id';
      const USER = 'u1-DISTINCTIVE-user-id';
      let lines: string[];
      const spies: jest.SpyInstance[] = [];
      beforeEach(() => {
        lines = [];
        for (const level of ['log', 'debug', 'warn', 'error', 'verbose'] as const) {
          spies.push(
            jest
              .spyOn(Logger.prototype, level)
              .mockImplementation(
                (...args: unknown[]) => void lines.push(args.map(String).join(' '))
              )
          );
        }
      });
      afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));
      const names = () =>
        lines.filter((l) => l.includes(FORM.slice(0, 8)) || l.includes(USER.slice(0, 8)));

      it('on a joined answer', async () => {
        const { service } = makeService(joining({ id: FORM }));
        await service.submit(
          FORM,
          { answers: {}, userId: USER, clientVersion: ANNOUNCING, announcedFields: ['cursus'] },
          'member'
        );
        expect(lines.length).toBeGreaterThan(0);
        expect(names()).toEqual([]);
      });

      it('on a refused answer (page out of date) and a declared one', async () => {
        const { service } = makeService(joining({ id: FORM }));
        await code(
          service.submit(
            FORM,
            { answers: {}, userId: USER, clientVersion: ANNOUNCING, announcedFields: [] },
            'member'
          )
        );
        await code(
          service.submit(
            FORM,
            {
              answers: {},
              userId: USER,
              clientVersion: ANNOUNCING,
              announcedFields: ['cursus'],
              declaredPromo: 2020,
            } as any,
            'member'
          )
        );
        expect(names()).toEqual([]);
      });
    });

    it('reads nothing for a build that cannot announce it: it is asked as before', async () => {
      for (const clientVersion of [undefined, '1.6.12']) {
        const { service, saved, accountIdentity } = makeService(joining());
        await service.submit('f1', { answers: {}, userId: 'u1', clientVersion }, 'member');
        expect(accountIdentity).not.toHaveBeenCalled();
        expect(saved[0].respondentIdentity).toMatchObject({ source: 'declared' });
      }
      const { service, saved } = makeService(joining());
      await service.submit(
        'f1',
        {
          answers: {},
          userId: 'u1',
          declaredFormation: 'ICM',
          declaredPromo: 2020,
          clientVersion: '1.7.2',
        },
        'member'
      );
      expect(saved[0].respondentIdentity).toEqual({
        source: 'declared',
        cursus: [{ promo: 2020, formation: 'ICM' }],
      });
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

    it('adds a Source column once an anonymous form holds a certified cursus, in the client words', async () => {
      const labels = {
        ...LABELS,
        identity: {
          ...LABELS.identity!,
          source: 'Source',
          sourceAccount: 'compte',
          sourceDeclared: 'declare',
        },
      };
      const form = baseForm({
        anonymous: true,
        guestFields: ['cursus'],
        respondentFields: ['cursus'],
      });
      const { service } = exporter(form, [
        sub({
          id: 's1',
          respondentIdentity: { source: 'account', cursus: [{ promo: 2024, formation: 'ISMIN' }] },
        }),
        sub({
          id: 's2',
          respondentIdentity: { source: 'declared', cursus: [{ promo: 2020, formation: 'ICM' }] },
        }),
      ]);
      const [header, first, second] = await rows(service, labels);
      expect(header).toEqual(['Date', 'Promo', 'Formation', 'Source', 'Menu']);
      expect(first.slice(1)).toEqual(['2024', 'ISMIN', 'compte', 'vege']);
      expect(second.slice(1)).toEqual(['2020', 'ICM', 'declare', 'vege']);
      // Declared alone: no column, nothing to tell apart. A build sending no source words gets the French ones.
      const declaredOnly = exporter(form, [
        sub({ respondentIdentity: { source: 'declared', cursus: [] } }),
      ]);
      expect((await rows(declaredOnly.service, labels))[0]).not.toContain('Source');
      const legacy = exporter(form, [
        sub({ respondentIdentity: { source: 'account', cursus: [] } }),
      ]);
      expect((await rows(legacy.service))[0]).toContain('Source');
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
