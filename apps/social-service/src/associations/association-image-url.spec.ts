import { BadRequestException } from '@nestjs/common';
import {
  ASSOCIATION_IMAGE_URL_CODE,
  assertAssociationImageUrl,
  isAllowedAssociationImageUrl,
} from './association-image-url';
import { AssociationsService } from './associations.service';
import type { Association } from './entities/association.entity';

/**
 * WHAT AN ASSOCIATION'S `logoUrl` MAY HOLD.
 *
 * The upload path writes `/api/media/public/<id>?v=<n>` and nothing else. The create and update
 * bodies also accept the field, so the same shape - or an absolute https image URL - is all they may
 * store: the value is drawn by every client that shows the association, and it is validated where it
 * is written rather than at each of those places.
 */
const ID = '11111111-1111-4111-8111-111111111111';

const ALLOWED = [
  '/api/media/public/0b0e3f1c-1d2e-4f5a-8b9c-0d1e2f3a4b5c?v=1727000000000',
  '/api/media/public/0b0e3f1c-1d2e-4f5a-8b9c-0d1e2f3a4b5c',
  'https://example.org/logo.png',
  'https://example.org/img/logo.webp?size=128',
];

const REFUSED = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  'http://example.org/logo.png',
  'x" onerror="alert(1)',
  '/api/media/public/abc" onerror="alert(1)',
  '/api/media/public/abc?v=1&x=<b>',
  'https://example.org/a"b.png',
  "https://example.org/a'b.png",
  'https://example.org/<svg>',
  'https://example.org/a b.png',
  '//example.org/logo.png',
  '/etc/passwd',
  'logo.png',
  `https://example.org/${'a'.repeat(2100)}`,
];

describe('isAllowedAssociationImageUrl', () => {
  it.each(ALLOWED)('accepts %s', (value) => {
    expect(isAllowedAssociationImageUrl(value)).toBe(true);
  });

  it.each(REFUSED)('refuses %s', (value) => {
    expect(isAllowedAssociationImageUrl(value)).toBe(false);
  });
});

describe('assertAssociationImageUrl', () => {
  it('throws a 400 carrying the typed code', () => {
    let thrown: unknown;
    try {
      assertAssociationImageUrl('javascript:alert(1)');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      code: ASSOCIATION_IMAGE_URL_CODE,
    });
  });
});

function makeService(seed: Partial<Association>) {
  const row = { id: ID, name: 'a', slug: 'a', updatedAt: new Date(0), ...seed } as Association;
  const assoRepo = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn(),
    update: jest.fn((_id: string, patch: Partial<Association>) => {
      Object.assign(row, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  // POSITIONAL, AND THIRTEEN LONG - keep aligned with the constructor in `associations.service.ts`.
  const service = new AssociationsService(
    assoRepo as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { deleteByPattern: jest.fn(() => Promise.resolve()) } as never,
    undefined as never,
    undefined as never,
    undefined as never
  );
  (service as never as Record<string, unknown>).findById = jest.fn(() => Promise.resolve(row));
  (service as never as Record<string, unknown>).invalidatePostListCaches = jest.fn(() =>
    Promise.resolve()
  );
  return { service, row, assoRepo };
}

describe('AssociationsService writes of logoUrl', () => {
  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'x" onerror="alert(1)'])(
    'update refuses %s and writes nothing',
    async (logoUrl) => {
      const { service, row, assoRepo } = makeService({ logoUrl: '/api/media/public/m?v=1' });
      await expect(service.update(ID, { logoUrl })).rejects.toMatchObject({
        response: { code: ASSOCIATION_IMAGE_URL_CODE },
      });
      expect(assoRepo.update).not.toHaveBeenCalled();
      expect(row.logoUrl).toBe('/api/media/public/m?v=1');
    }
  );

  it('update stores an allowed value unchanged', async () => {
    const { service, row } = makeService({});
    await service.update(ID, { logoUrl: 'https://example.org/logo.png' });
    expect(row.logoUrl).toBe('https://example.org/logo.png');
  });

  it('update clears the column on a blank value', async () => {
    const { service, row } = makeService({ logoUrl: '/api/media/public/m?v=1' });
    await service.update(ID, { logoUrl: '  ' });
    expect(row.logoUrl).toBeNull();
  });

  it('create refuses a hostile value before reading or writing anything', async () => {
    const { service, assoRepo } = makeService({});
    await expect(
      service.create({ name: 'A', slug: 'aa', logoUrl: 'javascript:alert(1)' }, 'u1', true)
    ).rejects.toMatchObject({ response: { code: ASSOCIATION_IMAGE_URL_CODE } });
    expect(assoRepo.findOne).not.toHaveBeenCalled();
    expect(assoRepo.create).not.toHaveBeenCalled();
  });
});
