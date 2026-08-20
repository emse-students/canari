import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PartnershipsService } from './partnerships.service';
import { PartnershipCard } from './entities/partnership-card.entity';
import { PartnershipCode } from './entities/partnership-code.entity';
import { Association } from './entities/association.entity';
import { ProductsService } from './products.service';
import { AssociationsService } from './associations.service';

describe('PartnershipsService claiming, gating and mode validation', () => {
  function makeService() {
    const manager: any = {
      query: jest.fn(() => Promise.resolve([])),
    };
    manager.transaction = jest.fn((cb: (m: unknown) => unknown) => cb(manager));
    const cardRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      remove: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const codeRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      manager,
    };
    const assoRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
    };
    const productsService = {
      isBuyerCotisant: jest.fn(() => Promise.resolve(false)),
    };
    const associationsService = {
      uploadPublicImage: jest.fn(() => Promise.resolve('media1')),
      deleteMediaBestEffort: jest.fn(() => Promise.resolve()),
    };

    const service = new PartnershipsService(
      cardRepo as unknown as Repository<PartnershipCard>,
      codeRepo as unknown as Repository<PartnershipCode>,
      assoRepo as unknown as Repository<Association>,
      productsService as unknown as ProductsService,
      associationsService as unknown as AssociationsService
    );

    return { service, cardRepo, codeRepo, assoRepo, productsService, associationsService, manager };
  }

  const card = (overrides: Partial<PartnershipCard> = {}): PartnershipCard =>
    ({
      id: 'card1',
      associationId: 'asso1',
      title: 'Partner discount',
      description: null,
      link: null,
      claimMode: 'code_pool',
      sharedCode: null,
      staticText: null,
      membersOnly: false,
      isActive: true,
      ...overrides,
    }) as PartnershipCard;

  const asso = (overrides: Partial<Association> = {}): Association =>
    ({ id: 'asso1', slug: 'bde', ...overrides }) as Association;

  describe('listActiveByAssoc / listAllActive - sharedCode leak', () => {
    it('never returns sharedCode in a listing, even for a shared_code card', async () => {
      const { service, cardRepo, assoRepo } = makeService();
      cardRepo.find.mockResolvedValue([
        card({ claimMode: 'shared_code', sharedCode: 'SECRET-CODE', membersOnly: true }),
      ]);
      assoRepo.find.mockResolvedValue([asso()]);

      const [byAssoc] = await service.listActiveByAssoc('asso1', 'user1');
      expect(byAssoc.sharedCode).toBeNull();

      const [allActive] = await service.listAllActive('user1');
      expect(allActive.sharedCode).toBeNull();
    });
  });

  describe('claimCard - code_pool idempotency', () => {
    it('assigns a code on first claim and returns the SAME code on a revisit, without a second write', async () => {
      const { service, cardRepo, codeRepo, manager } = makeService();
      cardRepo.findOne.mockResolvedValue(card());
      codeRepo.findOne
        .mockResolvedValueOnce(null) // first visit: no existing claim
        .mockResolvedValueOnce({ code: 'CODE1', claimedByUserId: 'user1' }); // revisit
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes('FOR UPDATE SKIP LOCKED')) return Promise.resolve([{ id: 'code-row-1' }]);
        if (sql.startsWith('UPDATE')) return Promise.resolve([{ code: 'CODE1' }]);
        return Promise.resolve([]);
      });

      const first = await service.claimCard('card1', 'user1');
      expect(first).toEqual({ mode: 'code_pool', code: 'CODE1' });
      expect(manager.transaction).toHaveBeenCalledTimes(1);

      const second = await service.claimCard('card1', 'user1');
      expect(second).toEqual({ mode: 'code_pool', code: 'CODE1' });
      // No second write: the revisit is answered entirely from the step-1 lookup.
      expect(manager.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('claimCard - concurrent exhaustion', () => {
    it('hands the single remaining code to exactly one of two concurrent claimants', async () => {
      const { service, cardRepo, codeRepo, manager } = makeService();
      cardRepo.findOne.mockResolvedValue(card());
      codeRepo.findOne.mockResolvedValue(null); // neither user has claimed yet

      // Simulates SKIP LOCKED across two "concurrent" transactions: the pool holds exactly one
      // unclaimed row, so the second SELECT (from whichever request runs second) finds nothing.
      const unclaimedRows: { id: string }[] = [{ id: 'code-row-1' }];
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          const row = unclaimedRows.shift();
          return Promise.resolve(row ? [row] : []);
        }
        if (sql.startsWith('UPDATE')) return Promise.resolve([{ code: 'CODE1' }]);
        return Promise.resolve([]);
      });

      const winner = await service.claimCard('card1', 'userA');
      expect(winner).toEqual({ mode: 'code_pool', code: 'CODE1' });

      await expect(service.claimCard('card1', 'userB')).rejects.toThrow(BadRequestException);
    });
  });

  describe('claimCard - membersOnly gating', () => {
    it('rejects a non-cotisant claimant', async () => {
      const { service, cardRepo, assoRepo, productsService } = makeService();
      cardRepo.findOne.mockResolvedValue(
        card({ membersOnly: true, claimMode: 'text', staticText: 'Show your ID' })
      );
      assoRepo.findOne.mockResolvedValue(asso());
      productsService.isBuyerCotisant.mockResolvedValue(false);

      await expect(service.claimCard('card1', 'user1')).rejects.toThrow(ForbiddenException);
    });

    it('allows a cotisant claimant', async () => {
      const { service, cardRepo, assoRepo, productsService } = makeService();
      cardRepo.findOne.mockResolvedValue(
        card({ membersOnly: true, claimMode: 'text', staticText: 'Show your ID' })
      );
      assoRepo.findOne.mockResolvedValue(asso());
      productsService.isBuyerCotisant.mockResolvedValue(true);

      const result = await service.claimCard('card1', 'user1');
      expect(result).toEqual({ mode: 'text', staticText: 'Show your ID' });
    });
  });

  describe('claimCard - not found', () => {
    it('throws when the card does not exist or is inactive', async () => {
      const { service, cardRepo } = makeService();
      cardRepo.findOne.mockResolvedValue(null);

      await expect(service.claimCard('missing', 'user1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create - mode/field mismatch validation', () => {
    it('rejects a text card that also carries sharedCode', async () => {
      const { service } = makeService();
      await expect(
        service.create('asso1', {
          title: 'X',
          claimMode: 'text',
          staticText: 'Show your ID',
          sharedCode: 'SNEAKY',
        } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a shared_code card missing sharedCode', async () => {
      const { service } = makeService();
      await expect(
        service.create('asso1', { title: 'X', claimMode: 'shared_code' } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a shared_code card that also carries staticText', async () => {
      const { service } = makeService();
      await expect(
        service.create('asso1', {
          title: 'X',
          claimMode: 'shared_code',
          sharedCode: 'PROMO10',
          staticText: 'Show your ID',
        } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a code_pool card carrying sharedCode or staticText', async () => {
      const { service } = makeService();
      await expect(
        service.create('asso1', {
          title: 'X',
          claimMode: 'code_pool',
          sharedCode: 'PROMO10',
        } as any)
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create('asso1', { title: 'X', claimMode: 'code_pool', staticText: 'nope' } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a well-formed card for each mode', async () => {
      const { service, cardRepo } = makeService();
      await expect(
        service.create('asso1', { title: 'X', claimMode: 'code_pool' } as any)
      ).resolves.toBeTruthy();
      await expect(
        service.create('asso1', {
          title: 'X',
          claimMode: 'shared_code',
          sharedCode: 'PROMO10',
        } as any)
      ).resolves.toBeTruthy();
      await expect(
        service.create('asso1', {
          title: 'X',
          claimMode: 'text',
          staticText: 'Show your ID',
        } as any)
      ).resolves.toBeTruthy();
      expect(cardRepo.save).toHaveBeenCalledTimes(3);
    });
  });

  describe('setCardIcon / clearCardIcon', () => {
    const file = { buffer: Buffer.from('x'), mimetype: 'image/png', size: 1024 };

    it('uploads the icon, sets iconMediaId/iconUrl, and deletes the previous media object', async () => {
      const { service, cardRepo, associationsService } = makeService();
      cardRepo.findOne.mockResolvedValue(card({ iconMediaId: 'old-media' } as any));
      associationsService.uploadPublicImage.mockResolvedValue('new-media');

      const result = await service.setCardIcon('asso1', 'card1', file, 'Bearer token');

      expect(associationsService.uploadPublicImage).toHaveBeenCalledWith(file, 'Bearer token');
      expect(result.iconMediaId).toBe('new-media');
      expect(result.iconUrl).toContain('/api/media/public/new-media');
      expect(associationsService.deleteMediaBestEffort).toHaveBeenCalledWith(
        'old-media',
        'Bearer token'
      );
    });

    it('rejects a file over the size limit', async () => {
      const { service, cardRepo } = makeService();
      cardRepo.findOne.mockResolvedValue(card());

      await expect(
        service.setCardIcon('asso1', 'card1', { ...file, size: 3 * 1024 * 1024 }, 'Bearer token')
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a disallowed mime type', async () => {
      const { service, cardRepo } = makeService();
      cardRepo.findOne.mockResolvedValue(card());

      await expect(
        service.setCardIcon('asso1', 'card1', { ...file, mimetype: 'image/gif' }, 'Bearer token')
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a missing bearer token', async () => {
      const { service, cardRepo } = makeService();
      cardRepo.findOne.mockResolvedValue(card());

      await expect(service.setCardIcon('asso1', 'card1', file, undefined)).rejects.toThrow(
        BadRequestException
      );
    });

    it('clears the icon and best-effort deletes the old media object', async () => {
      const { service, cardRepo, associationsService } = makeService();
      cardRepo.findOne.mockResolvedValue(card({ iconMediaId: 'old-media' } as any));

      const result = await service.clearCardIcon('asso1', 'card1', 'Bearer token');

      expect(result.iconMediaId).toBeNull();
      expect(result.iconUrl).toBeNull();
      expect(associationsService.deleteMediaBestEffort).toHaveBeenCalledWith(
        'old-media',
        'Bearer token'
      );
    });
  });
});
