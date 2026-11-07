import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as ExcelJS from 'exceljs';
import { FORM_GUEST_IDENTITY_MISSING, FORM_GUEST_IDENTITY_NOT_ASKED } from './answer-bounds';
import { CreateFormDto, GuestSubmitFormDto, SubmitFormDto } from './dto/form.dto';
import type { ExportLabels } from './export-labels';
import { FormsService } from './forms.service';
import {
  askedGuestFields,
  guestDisplayName,
  guestIdentityFor,
  guestPayerEmail,
  NO_GUEST_IDENTITY,
  storedGuestFields,
} from './guest-identity';
import { addProductGridSheets } from './product-grid-export';

/**
 * A GUEST IS ASKED FOR A NAME OR AN E-MAIL ONLY WHEN THE FORM ASKS (owner, 2026-11-06).
 *
 * Off by default; the creator ticks last name, first name, e-mail; each ticked field is required of
 * a guest; a field not ticked is refused, so nothing is stored that nobody asked for; a member is
 * never asked, and an answer from a member carrying one is refused rather than silently stripped.
 * The e-mail, when asked, is the address Lydia's request goes to: typed once.
 */
describe('guest identity on a public form', () => {
  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: 'u-owner',
    associationId: 'a1',
    title: 'Soiree',
    description: '',
    imageUrl: null,
    isPublic: true,
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
      { build: jest.fn(() => Promise.resolve({ answers: {} })) } as any,
      { count: jest.fn() } as any,
      {} as any,
      { enabled: () => false } as any,
      {} as any
    );
    return { service, saved, formRepo };
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
    it('reads the asked fields canonical: known names, once each, in page order', () => {
      expect(askedGuestFields(null)).toEqual([]);
      expect(askedGuestFields(['email', 'lastName', 'email', 'nickname'])).toEqual([
        'lastName',
        'email',
      ]);
      expect(askedGuestFields('email')).toEqual([]);
      expect(storedGuestFields([])).toBeNull();
      expect(storedGuestFields(['firstName', 'lastName'])).toEqual(['lastName', 'firstName']);
    });

    it('asks nothing by default, and stores nothing', () => {
      expect(guestIdentityFor([], {}, 'guest', 'f1')).toEqual(NO_GUEST_IDENTITY);
    });

    it('requires every asked field, and refuses a blank one', () => {
      expect(() => guestIdentityFor(['lastName'], {}, 'guest', 'f1')).toThrow(BadRequestException);
      expect(() => guestIdentityFor(['email'], { guestEmail: '   ' }, 'guest', 'f1')).toThrow(
        BadRequestException
      );
    });

    it('refuses a field the form does not ask, so nothing unasked is stored', () => {
      expect(() =>
        guestIdentityFor(
          ['lastName'],
          { guestLastName: 'Curie', guestEmail: 'm@x.fr' },
          'guest',
          'f1'
        )
      ).toThrow(BadRequestException);
    });

    it("refuses a member's answer that carries any of them", () => {
      expect(() =>
        guestIdentityFor(['lastName'], { guestLastName: 'Curie' }, 'member', 'f1')
      ).toThrow(BadRequestException);
      expect(guestIdentityFor(['lastName'], {}, 'member', 'f1')).toEqual(NO_GUEST_IDENTITY);
    });

    it('keeps what was typed, trimmed', () => {
      expect(
        guestIdentityFor(
          ['lastName', 'firstName', 'email'],
          { guestLastName: ' Curie ', guestFirstName: 'Marie', guestEmail: 'marie@x.fr ' },
          'guest',
          'f1'
        )
      ).toEqual({ guestLastName: 'Curie', guestFirstName: 'Marie', guestEmail: 'marie@x.fr' });
    });

    it('sends Lydia the asked e-mail, else the one typed at the payment step', () => {
      const asked = { ...NO_GUEST_IDENTITY, guestEmail: 'marie@x.fr' };
      expect(guestPayerEmail(asked, undefined)).toBe('marie@x.fr');
      expect(guestPayerEmail(NO_GUEST_IDENTITY, 'other@x.fr')).toBe('other@x.fr');
    });

    // One address, typed once: a second one beside the asked e-mail is refused, never dropped.
    // Control: drop the check in `guestIdentityFor` and the second address is silently ignored.
    it('refuses a payment-step address beside the asked e-mail', () => {
      expect(() =>
        guestIdentityFor(
          ['email'],
          { guestEmail: 'marie@x.fr', payerEmail: 'other@x.fr' },
          'guest',
          'f1'
        )
      ).toThrow(BadRequestException);
      // Without the asked e-mail, the payment-step address is the only one, and is taken.
      expect(guestIdentityFor([], { payerEmail: 'other@x.fr' }, 'guest', 'f1')).toEqual(
        NO_GUEST_IDENTITY
      );
    });

    it('names a guest by what they gave, or not at all', () => {
      expect(guestDisplayName({ guestFirstName: 'Marie', guestLastName: 'Curie' })).toBe(
        'Marie Curie'
      );
      expect(guestDisplayName({ guestLastName: 'Curie' })).toBe('Curie');
      expect(guestDisplayName({})).toBeNull();
    });
  });

  describe('the DTOs', () => {
    const errorsOf = async (cls: any, body: Record<string, unknown>) =>
      (await validate(plainToInstance(cls, body) as object)).map((e) => e.property);

    it('bounds a guest name at 100 characters and checks the e-mail shape', async () => {
      expect(
        await errorsOf(GuestSubmitFormDto, { answers: {}, guestLastName: 'x'.repeat(101) })
      ).toEqual(['guestLastName']);
      expect(
        await errorsOf(GuestSubmitFormDto, { answers: {}, guestEmail: 'not-an-email' })
      ).toEqual(['guestEmail']);
      expect(
        await errorsOf(GuestSubmitFormDto, {
          answers: {},
          guestLastName: 'Curie',
          guestFirstName: 'Marie',
          guestEmail: 'marie@x.fr',
        })
      ).toEqual([]);
    });

    it('takes only the three known field names on a form', async () => {
      const form = { title: 't', basePrice: 0, currency: 'eur', items: [] };
      expect(await errorsOf(CreateFormDto, { ...form, guestFields: ['email', 'phone'] })).toEqual([
        'guestFields',
      ]);
      expect(await errorsOf(CreateFormDto, { ...form, guestFields: ['email', 'email'] })).toEqual([
        'guestFields',
      ]);
      expect(
        await errorsOf(CreateFormDto, { ...form, guestFields: ['lastName', 'email'] })
      ).toEqual([]);
    });

    // Declared on the member DTO so the global pipe's whitelist does not strip them silently: the
    // service is what refuses them.
    it("keeps a member's guest fields for the service to refuse", () => {
      const dto = plainToInstance(SubmitFormDto, { answers: {}, guestEmail: 'x@x.fr' });
      expect(dto.guestEmail).toBe('x@x.fr');
    });
  });

  describe('the form settings', () => {
    it('serves the asked fields to the guest page, and none by default', async () => {
      expect((await makeService(baseForm()).service.getPublic('f1')).guestFields).toEqual([]);
      const asked = makeService(baseForm({ guestFields: ['email', 'lastName'] }));
      expect((await asked.service.getPublic('f1')).guestFields).toEqual(['lastName', 'email']);
    });

    it('stores a ticked list canonical, and an empty one as null', async () => {
      const { service, formRepo } = makeService(baseForm());
      const input = {
        title: 'Soiree',
        basePrice: 0,
        currency: 'eur',
        items: [],
        isPublic: true,
        allowMultipleSubmissions: true,
        ownerId: 'u-owner',
      } as any;
      await service.create({ ...input, guestFields: ['email', 'lastName'] }, true);
      expect(formRepo.create.mock.calls[0][0].guestFields).toEqual(['lastName', 'email']);
      await service.create({ ...input, guestFields: [] }, true);
      expect(formRepo.create.mock.calls[1][0].guestFields).toBeNull();
    });

    it('refuses to ask a guest for a name on an anonymous form', async () => {
      const { service } = makeService(baseForm());
      await expect(
        service.create(
          {
            title: 'Sondage',
            basePrice: 0,
            currency: 'eur',
            items: [],
            anonymous: true,
            guestFields: ['lastName'],
            ownerId: 'u-owner',
          } as any,
          true
        )
      ).rejects.toThrow(/anonymous form cannot ask a guest/);
    });

    // The UPDATE path (review of #3096): an edit is judged on the guest fields it WILL have - the
    // sent ones, else the stored ones - against the anonymity the form keeps.
    it('refuses an edit of an anonymous form that asks guests, sent or kept', async () => {
      const anonymous = baseForm({ anonymous: true, isPublic: true, guestFields: null });
      const sent = makeService(anonymous);
      jest.spyOn(sent.service, 'assertFormManager').mockResolvedValue(anonymous as any);
      await expect(
        sent.service.update('f1', { guestFields: ['email'] } as any, 'u-owner', true)
      ).rejects.toThrow(/anonymous form cannot ask a guest/);

      // A stored list the edit leaves out is still judged: the form would keep asking.
      const kept = baseForm({ anonymous: true, isPublic: true, guestFields: ['lastName'] });
      const keptService = makeService(kept);
      jest.spyOn(keptService.service, 'assertFormManager').mockResolvedValue(kept as any);
      await expect(
        keptService.service.update('f1', { anonymous: true, title: 'x' } as any, 'u-owner', true)
      ).rejects.toThrow(/anonymous form cannot ask a guest/);
      expect(keptService.formRepo.save).not.toHaveBeenCalled();
    });

    it('keeps the stored list when an edit leaves it out, and clears it when sent empty', async () => {
      const stored = baseForm({ guestFields: ['email'] });
      const { service, formRepo } = makeService(stored);
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(stored as any);
      await service.update('f1', { title: 'Soiree 2' } as any, 'u-owner', true);
      expect(formRepo.save.mock.calls[0][0].guestFields).toEqual(['email']);
      await service.update('f1', { guestFields: [] } as any, 'u-owner', true);
      expect(formRepo.save.mock.calls[1][0].guestFields).toBeNull();
    });
  });

  describe('a guest answer', () => {
    it('stores the names and the e-mail the form asked', async () => {
      const { service, saved } = makeService(
        baseForm({ guestFields: ['lastName', 'firstName', 'email'] })
      );
      await service.submit(
        'f1',
        {
          answers: { q1: 'vege' },
          guestLastName: 'Curie',
          guestFirstName: 'Marie',
          guestEmail: 'marie@x.fr',
        },
        'guest'
      );
      expect(saved[0]).toMatchObject({
        userId: null,
        guestLastName: 'Curie',
        guestFirstName: 'Marie',
        guestEmail: 'marie@x.fr',
      });
    });

    it('stores nothing about who answered when the form asks nothing', async () => {
      const { service, saved } = makeService(baseForm());
      await service.submit('f1', { answers: { q1: 'vege' } }, 'guest');
      expect(saved[0]).toMatchObject(NO_GUEST_IDENTITY);
    });

    it('refuses an answer missing an asked field, before anything is written', async () => {
      const { service, saved } = makeService(baseForm({ guestFields: ['lastName'] }));
      expect(await code(service.submit('f1', { answers: {} }, 'guest'))).toBe(
        FORM_GUEST_IDENTITY_MISSING
      );
      expect(saved).toHaveLength(0);
    });

    it('refuses a field the form does not ask', async () => {
      const { service, saved } = makeService(baseForm({ guestFields: ['lastName'] }));
      expect(
        await code(
          service.submit(
            'f1',
            { answers: {}, guestLastName: 'Curie', guestEmail: 'marie@x.fr' },
            'guest'
          )
        )
      ).toBe(FORM_GUEST_IDENTITY_NOT_ASKED);
      expect(saved).toHaveLength(0);
    });

    it("refuses a member's answer carrying a guest name, even on a form that asks guests", async () => {
      const { service, saved } = makeService(
        baseForm({ isPublic: true, guestFields: ['lastName'], allowMultipleSubmissions: true })
      );
      expect(
        await code(
          service.submit('f1', { answers: {}, userId: 'u1', guestLastName: 'Curie' }, 'member')
        )
      ).toBe(FORM_GUEST_IDENTITY_NOT_ASKED);
      expect(saved).toHaveLength(0);
    });
  });

  describe('the export', () => {
    const LABELS: ExportLabels = {
      date: 'Date',
      firstName: 'Prenom',
      lastName: 'Nom',
      amount: 'Montant',
      status: 'Statut',
      statuses: { free: 'Gratuit' },
      email: 'E-mail',
      guest: 'Invite',
    };

    function exportService(form: Record<string, unknown>, submissions: Record<string, unknown>[]) {
      const formRepo: any = {
        findOne: jest.fn(() => Promise.resolve(form)),
        manager: {
          query: jest.fn(() => Promise.resolve([{ id: 'u1', firstName: 'Ada', lastName: 'L' }])),
        },
      };
      const submissionRepo: any = { find: jest.fn(() => Promise.resolve(submissions)) };
      return new FormsService(
        formRepo,
        submissionRepo,
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
    }

    const row = (over: Record<string, unknown>) => ({
      id: '1a2b3c4d-0000-4000-8000-000000000001',
      userId: null,
      answers: {},
      totalPaid: 0,
      paymentStatus: 'free',
      createdAt: new Date(2026, 10, 6, 12, 0),
      ...over,
    });

    async function sheet(service: FormsService, labels = LABELS): Promise<unknown[][]> {
      const { buffer } = await service.exportSubmissions('f1', labels);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const rows: unknown[][] = [];
      workbook.worksheets[0].eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
      return rows;
    }

    it("writes a guest's names in the name columns and an e-mail column when asked", async () => {
      const service = exportService(baseForm({ guestFields: ['lastName', 'firstName', 'email'] }), [
        row({ guestLastName: 'Curie', guestFirstName: 'Marie', guestEmail: 'marie@x.fr' }),
        row({ id: 's2', userId: 'u1' }),
      ]);
      const [headers, guest, member] = await sheet(service);
      expect(headers).toEqual(['Date', 'Prenom', 'Nom', 'Invite', 'E-mail', 'Menu']);
      expect(guest.slice(1, 5)).toEqual(['Marie', 'Curie', '1A2B-3C4D', 'marie@x.fr']);
      // A member's row has no guest marker: the typed name and an account's name are told apart.
      expect(member.slice(1, 4)).toEqual(['Ada', 'L', '']);
    });

    // P2-1 of the review of #3096: a name a guest TYPED must never read as an account's name.
    // Control: drop the guest column and the guest row reads exactly like a member's.
    it('marks every guest row with its reference, even with no name asked', async () => {
      const service = exportService(baseForm(), [row({}), row({ id: 's2', userId: 'u1' })]);
      const [headers, guest] = await sheet(service);
      expect(headers).toEqual(['Date', 'Prenom', 'Nom', 'Invite', 'Menu']);
      expect(guest[3]).toBe('1A2B-3C4D');
    });

    it('draws no guest column when every answer has an account', async () => {
      const service = exportService(baseForm(), [row({ userId: 'u1' })]);
      expect((await sheet(service))[0]).toEqual(['Date', 'Prenom', 'Nom', 'Menu']);
    });

    it('refuses an export that would write the guest column without its word', async () => {
      const { guest: _guest, ...without } = LABELS;
      const service = exportService(baseForm(), [row({})]);
      await expect(service.exportSubmissions('f1', without)).rejects.toThrow(/"guest"/);
    });

    it('draws no e-mail column on a form that never asked one', async () => {
      const service = exportService(baseForm(), [row({ guestLastName: 'Curie' })]);
      expect((await sheet(service))[0]).not.toContain('E-mail');
    });

    it('keeps the column for answers given while the form asked, after it stopped', async () => {
      const service = exportService(baseForm(), [row({ guestEmail: 'marie@x.fr' })]);
      expect((await sheet(service))[0]).toContain('E-mail');
    });

    it('refuses an export that would write the column without its word', async () => {
      const { email: _email, ...without } = LABELS;
      const service = exportService(baseForm({ guestFields: ['email'] }), [row({})]);
      await expect(service.exportSubmissions('f1', without)).rejects.toThrow(/"email"/);
    });

    it('names a guest buyer on the grid sheet by name AND reference, else by the reference', () => {
      const workbook = new ExcelJS.Workbook();
      const line = {
        itemId: 'g',
        itemLabel: 'Commande',
        rowId: 'r',
        rowLabel: 'Pizza',
        colId: 'c',
        colLabel: 'L',
        tierId: null,
        tierLabel: null,
        unitCents: 500,
        quantity: 1,
        lineCents: 500,
      };
      const words = Object.fromEntries(
        [
          'articlesSheet',
          'totalsSheet',
          'buyer',
          'guest',
          'question',
          'row',
          'column',
          'category',
          'othersCategory',
          'quantity',
          'unitPrice',
          'lineTotal',
          'total',
          'amount',
          'received',
          'awaitingCash',
        ].map((k) => [k, k === 'guest' ? 'Invite' : k])
      ) as any;
      addProductGridSheets(
        workbook,
        [
          {
            id: 'g',
            label: 'Commande',
            type: 'product_grid',
            productGrid: { rows: [], columns: [] },
          },
        ] as any,
        [
          {
            id: 'aaaabbbb-0000-4000-8000-000000000001',
            userId: null,
            paymentStatus: 'paid',
            createdAt: new Date(),
            lines: [line],
            guestFirstName: 'Marie',
            guestLastName: 'Curie',
          },
          {
            id: 'ccccdddd-0000-4000-8000-000000000002',
            userId: null,
            paymentStatus: 'paid',
            createdAt: new Date(),
            lines: [line],
          },
        ] as any,
        new Map(),
        LABELS,
        words
      );
      const buyers: unknown[] = [];
      workbook.getWorksheet('articlesSheet')!.eachRow((r, n) => {
        if (n > 1) buyers.push((r.values as unknown[])[2]);
      });
      expect(buyers[0]).toBe('Marie Curie (Invite AAAA-BBBB)');
      expect(buyers[1]).toBe('Invite CCCC-DDDD');
    });
  });
});
