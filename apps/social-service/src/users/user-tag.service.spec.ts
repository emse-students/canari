import { Repository } from 'typeorm';
import { UserTagService } from './user-tag.service';
import { UserTag } from './entities/user-tag.entity';

describe('UserTagService.listCotisants / exportCotisants', () => {
  function makeService() {
    const repo = {
      findOne: jest.fn(),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      manager: { query: jest.fn() },
    };
    const service = new UserTagService(repo as unknown as Repository<UserTag>);
    return { service, repo };
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
      repo.manager.query.mockResolvedValueOnce([{ count: '1' }]).mockResolvedValueOnce([row()]);

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
      repo.manager.query.mockResolvedValueOnce([{ count: '0' }]).mockResolvedValueOnce([]);

      await service.listCotisants('asso1', { search: '  ali  ' });

      const [countSql, countParams] = repo.manager.query.mock.calls[0];
      expect(countSql).toContain('ILIKE');
      expect(countParams).toEqual(['asso1', 'ali']);
    });

    it('treats an empty/whitespace-only search as no filter (null param)', async () => {
      const { service, repo } = makeService();
      repo.manager.query.mockResolvedValueOnce([{ count: '0' }]).mockResolvedValueOnce([]);

      await service.listCotisants('asso1', { search: '   ' });

      const [, countParams] = repo.manager.query.mock.calls[0];
      expect(countParams[1]).toBeNull();
    });

    it('applies default offset/limit and reports hasMore correctly', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '3' }])
        .mockResolvedValueOnce([row(), row()]);

      const page = await service.listCotisants('asso1');

      const [, rowsParams] = repo.manager.query.mock.calls[1];
      // params = [assocId, search, limit, offset]
      expect(rowsParams[2]).toBe(50);
      expect(rowsParams[3]).toBe(0);
      expect(page.hasMore).toBe(true); // 2 returned, offset 0, total 3
    });

    it('honors a requested offset/limit and caps the limit at 200', async () => {
      const { service, repo } = makeService();
      repo.manager.query.mockResolvedValueOnce([{ count: '500' }]).mockResolvedValueOnce([]);

      await service.listCotisants('asso1', { offset: 40, limit: 999 });

      const [, rowsParams] = repo.manager.query.mock.calls[1];
      expect(rowsParams[2]).toBe(200); // capped
      expect(rowsParams[3]).toBe(40);
    });

    it('reports hasMore=false when the returned page reaches the total', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '2' }])
        .mockResolvedValueOnce([row(), row()]);

      const page = await service.listCotisants('asso1', { offset: 0, limit: 50 });
      expect(page.hasMore).toBe(false);
    });

    it('groups cotisants without a promo via NULLS LAST ordering (SQL-level, asserted by presence in ORDER BY)', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([row({ promo: null, firstName: 'External', lastName: 'Staffer' })]);

      const page = await service.listCotisants('asso1');
      expect(page.items[0].promo).toBeNull();
      const [rowsSql] = repo.manager.query.mock.calls[1];
      expect(rowsSql).toMatch(/promo ASC NULLS LAST/);
    });
  });

  describe('exportCotisants', () => {
    it('produces a non-empty XLSX buffer with the expected header row', async () => {
      const { service, repo } = makeService();
      repo.manager.query
        .mockResolvedValueOnce([{ name: 'BDE' }])
        .mockResolvedValueOnce([row(), row({ userId: 'user2', promo: null, lastName: 'Zed' })]);

      const { buffer, title } = await service.exportCotisants('asso1');

      expect(buffer.byteLength).toBeGreaterThan(0);
      expect(title).toBe('cotisants_BDE');

      // Read back the workbook to check header labels (no email column - PII).
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      const headerRow = sheet.getRow(1).values as unknown[];
      const headers = headerRow.slice(1) as string[];
      expect(headers).toEqual(['Nom', 'Prénom', 'Promo', 'Cotisation', 'Date', 'Échéance']);
      expect(headers).not.toContain('Email');
    });

    it('falls back to a generic title when the association name cannot be resolved', async () => {
      const { service, repo } = makeService();
      repo.manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const { title } = await service.exportCotisants('missing-asso');
      expect(title).toBe('cotisants_cotisants');
    });
  });

  describe('grantCotisant', () => {
    it('derives the canonical tag from the association slug/mode and grants it', async () => {
      const { service, repo } = makeService();
      repo.manager.query.mockResolvedValueOnce([{ slug: 'bde', cotisationMode: 'lifetime' }]);
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
  });
});
