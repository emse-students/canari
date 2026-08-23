import { Repository } from 'typeorm';
import { UserTagService } from './user-tag.service';
import { UserTag } from './entities/user-tag.entity';

describe('UserTagService.listCotisants / exportCotisants', () => {
  function makeService() {
    const repo: any = {
      findOne: jest.fn(),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      manager: { query: jest.fn() },
    };
    // A transaction runs against the same mock, so a test can assert what happened inside it.
    repo.manager.getRepository = jest.fn(() => repo);
    repo.manager.transaction = jest.fn((cb: (m: unknown) => unknown) => cb(repo.manager));
    const service = new UserTagService(repo as unknown as Repository<UserTag>);
    return { service, repo };
  }

  /**
   * Answers the association/product lookups by SQL shape rather than call order, so a test can
   * describe a tier catalogue without counting how many times the code reads it.
   */
  function mockCatalogue(
    repo: { manager: { query: jest.Mock } },
    asso: { slug: string; cotisationMode: string | null } | null,
    tiers: { name: string; variantKey: string | null }[]
  ) {
    repo.manager.query.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('FROM associations') ? (asso ? [asso] : []) : tiers)
    );
  }

  const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
    userId: 'user1',
    tagName: 'cotisant:bde',
    grantedAt: new Date('2026-01-15T00:00:00Z'),
    expiresAt: null,
    firstName: 'Alice',
    lastName: 'Martin',
    promo: 2026,
    ...overrides,
  });

  describe('listCotisants', () => {
    it('queries active tags only, enriched with users, sorted promo/lastName/firstName', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([row()])
        .mockResolvedValueOnce([]); // buildTierLabelMap: association not found -> empty map

      const page = await service.listCotisants('asso1');

      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(1);
      expect(page.hasMore).toBe(false);
      expect(page.items[0]).toMatchObject({
        userId: 'user1',
        tagName: 'cotisant:bde',
        firstName: 'Alice',
        lastName: 'Martin',
        promo: 2026,
      });

      // Both queries filter on issuingAssocId + active-only (expiresAt IS NULL OR expiresAt > NOW()).
      const [countSql, countParams] = repo.manager.query.mock.calls[0];
      expect(countSql).toContain('t."issuingAssocId" = $1');
      expect(countSql).toContain('t."expiresAt" IS NULL OR t."expiresAt" > NOW()');
      expect(countParams[0]).toBe('asso1');

      const [rowsSql] = repo.manager.query.mock.calls[1];
      expect(rowsSql).toContain(
        'ORDER BY u.promo ASC NULLS LAST, u."lastName" ASC, u."firstName" ASC'
      );
    });

    it('passes a case-insensitive search term as a parameterized value', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.listCotisants('asso1', { search: '  ali  ' });

      const [countSql, countParams] = repo.manager.query.mock.calls[0];
      expect(countSql).toContain('ILIKE');
      expect(countParams).toEqual(['asso1', 'ali']);
    });

    it('treats an empty/whitespace-only search as no filter (null param)', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.listCotisants('asso1', { search: '   ' });

      const [, countParams] = repo.manager.query.mock.calls[0];
      expect(countParams[1]).toBeNull();
    });

    it('applies default offset/limit and reports hasMore correctly', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '3' }])
        .mockResolvedValueOnce([row(), row()])
        .mockResolvedValueOnce([]);

      const page = await service.listCotisants('asso1');

      const [, rowsParams] = repo.manager.query.mock.calls[1];
      // params = [assocId, search, limit, offset]
      expect(rowsParams[2]).toBe(50);
      expect(rowsParams[3]).toBe(0);
      expect(page.hasMore).toBe(true); // 2 returned, offset 0, total 3
    });

    it('honors a requested offset/limit and caps the limit at 200', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '500' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.listCotisants('asso1', { offset: 40, limit: 999 });

      const [, rowsParams] = repo.manager.query.mock.calls[1];
      expect(rowsParams[2]).toBe(200); // capped
      expect(rowsParams[3]).toBe(40);
    });

    it('reports hasMore=false when the returned page reaches the total', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '2' }])
        .mockResolvedValueOnce([row(), row()])
        .mockResolvedValueOnce([]);

      const page = await service.listCotisants('asso1', { offset: 0, limit: 50 });
      expect(page.hasMore).toBe(false);
    });

    it('groups cotisants without a promo via NULLS LAST ordering (SQL-level, asserted by presence in ORDER BY)', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([row({ promo: null, firstName: 'External', lastName: 'Staffer' })])
        .mockResolvedValueOnce([]);

      const page = await service.listCotisants('asso1');
      expect(page.items[0].promo).toBeNull();
      const [rowsSql] = repo.manager.query.mock.calls[1];
      expect(rowsSql).toMatch(/promo ASC NULLS LAST/);
    });

    it('labels tiered roster rows with their tier product name, leaving the base tier unlabeled', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '2' }])
        .mockResolvedValueOnce([
          row({ tagName: 'cotisant:cercle-avec-alcool' }),
          row({ userId: 'user2', tagName: 'cotisant:cercle' }),
        ])
        .mockResolvedValueOnce([{ slug: 'cercle', cotisationMode: 'lifetime' }])
        .mockResolvedValueOnce([{ name: 'Avec alcool', variantKey: 'avec-alcool' }]);

      const page = await service.listCotisants('asso1');
      expect(page.items[0].tier).toBe('Avec alcool');
      expect(page.items[1].tier).toBeNull();
    });
  });

  describe('exportCotisants', () => {
    it('produces a non-empty XLSX buffer with the expected header row', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ name: 'BDE' }])
        .mockResolvedValueOnce([row(), row({ userId: 'user2', promo: null, lastName: 'Zed' })])
        .mockResolvedValueOnce([]); // buildTierLabelMap: association not found -> empty map

      const { buffer, title } = await service.exportCotisants('asso1');

      expect(buffer.byteLength).toBeGreaterThan(0);
      expect(title).toBe('cotisants_BDE');

      // Read back the workbook to check header labels (no email column - PII).
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      // Cast bridges the Node `Buffer<ArrayBufferLike>` vs exceljs `Buffer`
      // typing mismatch without resorting to `any` (keeps no-unsafe-argument happy).
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.worksheets[0];
      const headerRow = sheet.getRow(1).values as unknown[];
      const headers = headerRow.slice(1) as string[];
      expect(headers).toEqual([
        'Nom',
        'Prénom',
        'Promo',
        'Cotisation',
        'Forfait',
        'Date',
        'Échéance',
      ]);
      expect(headers).not.toContain('Email');
    });

    it('falls back to a generic title when the association name cannot be resolved', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const { title } = await service.exportCotisants('missing-asso');
      expect(title).toBe('cotisants_cotisants');
    });

    it('fills the Forfait column with the tier name for tiered rows', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ name: 'Cercle' }])
        .mockResolvedValueOnce([row({ tagName: 'cotisant:cercle-avec-alcool' })])
        .mockResolvedValueOnce([{ slug: 'cercle', cotisationMode: 'lifetime' }])
        .mockResolvedValueOnce([{ name: 'Avec alcool', variantKey: 'avec-alcool' }]);

      const { buffer } = await service.exportCotisants('asso1');

      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.worksheets[0];
      const dataRow = sheet.getRow(2).values as unknown[];
      expect(dataRow[5]).toBe('Avec alcool'); // 1-indexed: Nom,Prenom,Promo,Cotisation,Forfait
    });
  });

  describe('getActiveTag', () => {
    it('returns null when the user holds no such tag', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue(null);

      expect(await service.getActiveTag('user1', 'cotisant:bde')).toBeNull();
    });

    it('returns the tag row when it never expires', async () => {
      const { service, repo } = makeService();
      const tag = { userId: 'user1', tagName: 'cotisant:bde', expiresAt: null };
      repo.findOne.mockResolvedValue(tag);

      expect(await service.getActiveTag('user1', 'cotisant:bde')).toBe(tag);
    });

    it('returns null once the tag has expired', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({
        userId: 'user1',
        tagName: 'cotisant:bde-2025-2026',
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      });

      expect(await service.getActiveTag('user1', 'cotisant:bde-2025-2026')).toBeNull();
    });

    it('returns the tag row while it is still valid', async () => {
      const { service, repo } = makeService();
      const tag = {
        userId: 'user1',
        tagName: 'cotisant:bde-2025-2026',
        expiresAt: new Date('2999-01-01T00:00:00Z'),
      };
      repo.findOne.mockResolvedValue(tag);

      expect(await service.getActiveTag('user1', 'cotisant:bde-2025-2026')).toBe(tag);
    });
  });

  describe('grantCotisant', () => {
    const cercleTiers = [
      { name: 'Avec alcool', variantKey: 'avec-alcool' },
      { name: 'Sans alcool', variantKey: 'sans-alcool' },
    ];

    it('derives the canonical tag from the association slug/mode and grants it', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'bde', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
      ]);
      repo.findOne.mockResolvedValue(null);

      const tag = await service.grantCotisant('asso1', 'user1', 'admin1');

      expect(tag).toMatchObject({
        userId: 'user1',
        tagName: 'cotisant:bde',
        issuingAssocId: 'asso1',
        grantedBy: 'admin1',
        expiresAt: null,
      });
    });

    it('rejects when cotisation is not enabled (no mode set)', async () => {
      const { service, repo } = makeService();
      repo.manager.query.mockResolvedValueOnce([{ slug: 'bde', cotisationMode: null }]);

      await expect(service.grantCotisant('asso1', 'user1', 'admin1')).rejects.toThrow(
        'Cotisation is not enabled'
      );
    });

    it('rejects when the association does not exist', async () => {
      const { service, repo } = makeService();
      repo.manager.query.mockResolvedValueOnce([]);

      await expect(service.grantCotisant('missing', 'user1', 'admin1')).rejects.toThrow(
        'Association not found'
      );
    });

    // WP-COT-10: a manual add used to always grant the base tag, so a multi-tier association
    // could not assign a forfait by hand and the roster's "Forfait" column stayed blank.
    it('grants the requested tier tag rather than the base one', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, cercleTiers);
      repo.findOne.mockResolvedValue(null);

      const tag = await service.grantCotisant('asso1', 'user1', 'admin1', 'avec-alcool');

      expect(tag).toMatchObject({ tagName: 'cotisant:cercle-avec-alcool' });
    });

    it('revokes the other tiers in the same transaction, so no user holds two forfaits', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, cercleTiers);
      repo.findOne.mockResolvedValue(null);

      await service.grantCotisant('asso1', 'user1', 'admin1', 'avec-alcool');

      expect(repo.manager.transaction).toHaveBeenCalled();
      expect(repo.delete).toHaveBeenCalledWith({
        userId: 'user1',
        tagName: 'cotisant:cercle-sans-alcool',
      });
      expect(repo.delete).not.toHaveBeenCalledWith({
        userId: 'user1',
        tagName: 'cotisant:cercle-avec-alcool',
      });
    });

    it('rejects a tier the association does not offer', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, cercleTiers);

      await expect(
        service.grantCotisant('asso1', 'user1', 'admin1', 'avec-champagne')
      ).rejects.toThrow('Unknown cotisation tier');
    });

    it('rejects a base-tier grant when the association only has named tiers', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, cercleTiers);

      await expect(service.grantCotisant('asso1', 'user1', 'admin1')).rejects.toThrow(
        'no base tier'
      );
    });
  });

  // WP-COT-9: MANAGE_MEMBERS is per-association, so the tag id alone must not be enough to reach
  // a row - an admin of one association could otherwise revoke any other association's cotisant.
  describe('revoke', () => {
    it('scopes the delete to the issuing association', async () => {
      const { service, repo } = makeService();

      await service.revoke('tag1', 'asso1');

      expect(repo.delete).toHaveBeenCalledWith({ id: 'tag1', issuingAssocId: 'asso1' });
    });

    it('throws 404 when the tag belongs to another association', async () => {
      const { service, repo } = makeService();
      repo.delete.mockResolvedValue({ affected: 0 });

      await expect(service.revoke('tag-of-other-asso', 'asso1')).rejects.toThrow('Tag not found');
    });
  });

  describe('listCotisationTiers', () => {
    it('resolves each membership product to the tag it grants', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
        { name: 'Avec alcool', variantKey: 'avec-alcool' },
      ]);

      expect(await service.listCotisationTiers('asso1')).toEqual([
        { variantKey: null, name: 'Cotisation', tagName: 'cotisant:cercle' },
        {
          variantKey: 'avec-alcool',
          name: 'Avec alcool',
          tagName: 'cotisant:cercle-avec-alcool',
        },
      ]);
    });

    it('returns nothing when the association has no cotisation mode', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'bde', cotisationMode: null }, []);

      expect(await service.listCotisationTiers('asso1')).toEqual([]);
    });

    // `isActive` says a tier can be BOUGHT, not that it exists: an association whose Stripe
    // account is not onboarded has every tier inactive, and its cotisants must still be listed,
    // grantable and recognized.
    it('lists tiers that are not on sale', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, []);

      await service.listCotisationTiers('asso1');
      expect(repo.manager.query.mock.calls[1][0]).not.toContain('"isActive"');
    });
  });

  // `holdsCotisation` is the predicate behind the forms member price. It derives the tier tags on
  // every call rather than comparing against a stored string, which is the whole point: a form
  // configured last year must recognize this year's cotisants (migration 050). Every case here
  // uses `lifetime`, whose tags carry no year, so nothing in this block depends on the wall clock.
  describe('holdsCotisation', () => {
    /** Makes exactly `held` the set of tag names the user holds, all non-expiring. */
    function holds(repo: { findOne: jest.Mock }, held: string[]) {
      repo.findOne.mockImplementation(({ where }: { where: { tagName: string } }) =>
        Promise.resolve(held.includes(where.tagName) ? { tagName: where.tagName, expiresAt: null } : null)
      );
    }

    it('answers false when the association has no cotisation at all', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'bde', cotisationMode: null }, []);
      holds(repo, ['cotisant:bde']);

      // The user even holds a plausible tag - it is the association that sells no tier, so there
      // is no membership to hold. Answering true here would give a member price to everyone.
      expect(await service.holdsCotisation('user1', 'asso1', 'any')).toBe(false);
    });

    it('accepts any tier when asked for "any"', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
        { name: 'Avec alcool', variantKey: 'avec-alcool' },
      ]);
      holds(repo, ['cotisant:cercle-avec-alcool']);

      expect(await service.holdsCotisation('user1', 'asso1', 'any')).toBe(true);
    });

    it('answers false for "any" when the user holds none of the tiers', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
        { name: 'Avec alcool', variantKey: 'avec-alcool' },
      ]);
      holds(repo, ['cotisant:bde', 'staff']);

      expect(await service.holdsCotisation('user1', 'asso1', 'any')).toBe(false);
    });

    it('requires the named tier, and refuses a sibling', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
        { name: 'Avec alcool', variantKey: 'avec-alcool' },
      ]);
      holds(repo, ['cotisant:cercle']);

      expect(await service.holdsCotisation('user1', 'asso1', 'avec-alcool')).toBe(false);
      expect(await service.holdsCotisation('user1', 'asso1', null)).toBe(true);
    });

    // `null` is the BASE tier here, never "any tier" - the sentinel `'any'` exists precisely so
    // that the two can never be confused. A member-price gate that read null as the base tier
    // would quietly exclude every buyer of a named forfait.
    it('reads null as the base tier and not as "any tier"', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
        { name: 'Avec alcool', variantKey: 'avec-alcool' },
      ]);
      holds(repo, ['cotisant:cercle-avec-alcool']);

      expect(await service.holdsCotisation('user1', 'asso1', null)).toBe(false);
      expect(await service.holdsCotisation('user1', 'asso1', 'any')).toBe(true);
    });

    // A renamed or deleted tier still named by a form: nobody qualifies, and the log has to say so
    // rather than leave an admin wondering why the member price stopped applying.
    it('answers false and warns when asked for a tier the association does not sell', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'cercle', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
      ]);
      holds(repo, ['cotisant:cercle', 'cotisant:cercle-ancien-forfait']);
      const warn = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn');

      expect(await service.holdsCotisation('user1', 'asso1', 'ancien-forfait')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ancien-forfait'));
    });

    it('does not count an expired tag', async () => {
      const { service, repo } = makeService();
      mockCatalogue(repo, { slug: 'bde', cotisationMode: 'lifetime' }, [
        { name: 'Cotisation', variantKey: null },
      ]);
      repo.findOne.mockResolvedValue({
        tagName: 'cotisant:bde',
        expiresAt: new Date('2000-01-01T00:00:00Z'),
      });

      expect(await service.holdsCotisation('user1', 'asso1', 'any')).toBe(false);
    });
  });
});
