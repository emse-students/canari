import { ForbiddenException } from '@nestjs/common';
import {
  assertAgendaSignature,
  canonicalAgendaSelection,
  selectionWithinSpaces,
  signAgendaSelection,
} from './agenda-signature';
import { AssociationsService } from './associations.service';

const KEY = 'agenda-test-key-0123456789abcdef0123456789';

describe('agenda signature', () => {
  const previous = process.env.AGENDA_SIGNING_KEY;
  beforeAll(() => {
    process.env.AGENDA_SIGNING_KEY = KEY;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previous;
  });

  const sel = { campus: 'gardanne', formation: null, associationId: null } as const;

  it('is deterministic, names no one, and verifies in constant time', () => {
    const sig = signAgendaSelection(sel);
    expect(signAgendaSelection({ ...sel })).toBe(sig);
    expect(() => assertAgendaSignature(sel, sig)).not.toThrow();
  });

  it('keeps every field of the selection apart (no concatenation ambiguity)', () => {
    const a = canonicalAgendaSelection({ campus: null, formation: 'ICM', associationId: null });
    const b = canonicalAgendaSelection({ campus: null, formation: null, associationId: 'ICM' });
    expect(a).not.toBe(b);
  });

  it('rejects a key shorter than 32 characters instead of signing with it', () => {
    process.env.AGENDA_SIGNING_KEY = 'short';
    try {
      expect(() => signAgendaSelection(sel)).toThrow('not configured');
    } finally {
      process.env.AGENDA_SIGNING_KEY = KEY;
    }
  });

  describe('selectionWithinSpaces', () => {
    const spaces = [
      { campus: 'gardanne', formation: 'ICM' },
      { campus: 'gardanne', formation: 'ISMIN' },
    ] as const;
    it('allows exactly the reader own pairs, never a campus or a formation alone', () => {
      expect(selectionWithinSpaces({ campus: 'gardanne', formation: 'ICM' }, spaces)).toBe(true);
      expect(selectionWithinSpaces({ campus: 'gardanne', formation: 'ISMIN' }, spaces)).toBe(true);
      expect(selectionWithinSpaces({ campus: 'gardanne', formation: null }, spaces)).toBe(false);
      expect(selectionWithinSpaces({ campus: null, formation: 'ISMIN' }, spaces)).toBe(false);
    });
    it('refuses another campus, another formation, and a pair that is not one of their spaces', () => {
      expect(selectionWithinSpaces({ campus: 'saint-etienne', formation: null }, spaces)).toBe(
        false
      );
      expect(selectionWithinSpaces({ campus: null, formation: 'FSSS' }, spaces)).toBe(false);
      expect(selectionWithinSpaces({ campus: 'saint-etienne', formation: 'ICM' }, spaces)).toBe(
        false
      );
    });
    it('lets a reader tied to no formation follow their own campus whole, and nothing else', () => {
      expect(
        selectionWithinSpaces({ campus: 'saint-etienne', formation: null }, [], 'saint-etienne')
      ).toBe(true);
      expect(
        selectionWithinSpaces({ campus: 'gardanne', formation: null }, [], 'saint-etienne')
      ).toBe(false);
      expect(
        selectionWithinSpaces({ campus: 'saint-etienne', formation: 'ICM' }, [], 'saint-etienne')
      ).toBe(false);
      expect(selectionWithinSpaces({ campus: null, formation: 'ICM' }, [], 'saint-etienne')).toBe(
        false
      );
    });
    it('refuses everything to a reader with no space, but not an association-only selection', () => {
      expect(selectionWithinSpaces({ campus: 'gardanne', formation: null }, [])).toBe(false);
      expect(selectionWithinSpaces({ campus: null, formation: null }, [])).toBe(true);
    });
  });
});

describe('AssociationsService.signAgendaFeedSelection', () => {
  const previous = process.env.AGENDA_SIGNING_KEY;
  beforeAll(() => {
    process.env.AGENDA_SIGNING_KEY = KEY;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previous;
  });

  function makeService(
    spaces: Array<{ campus: string; formation: string }>,
    profile: { campus: string | null; cursus: unknown } | null = null
  ) {
    const svc = Object.create(AssociationsService.prototype) as AssociationsService;
    Object.assign(svc, {
      assoRepo: {
        manager: {
          query: jest.fn((sql: string) =>
            Promise.resolve(sql.includes('FROM users WHERE') ? (profile ? [profile] : []) : spaces)
          ),
        },
      },
      logger: { warn: jest.fn(), log: jest.fn() },
      findById: jest.fn(() => Promise.resolve({})),
    });
    return svc;
  }

  it('signs the reader own space and refuses another with a typed 403', async () => {
    const svc = makeService([{ campus: 'gardanne', formation: 'ICM' }]);
    const ok = await svc.signAgendaFeedSelection(
      'user-1',
      { campus: 'gardanne', formation: 'ICM' },
      null
    );
    expect(() =>
      assertAgendaSignature({ campus: 'gardanne', formation: 'ICM', associationId: null }, ok.sig)
    ).not.toThrow();
    const refused = svc.signAgendaFeedSelection(
      'user-1',
      { campus: 'saint-etienne', formation: 'ICM' },
      null
    );
    await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refused).rejects.toMatchObject({
      response: { code: 'AGENDA_SELECTION_FORBIDDEN' },
    });
  });

  it('signs the whole own campus for staff (campus, empty cursus), and nothing narrower or wider', async () => {
    const svc = makeService([], { campus: 'saint-etienne', cursus: [] });
    const { sig } = await svc.signAgendaFeedSelection(
      'staff-1',
      { campus: 'saint-etienne', formation: null },
      null
    );
    expect(() =>
      assertAgendaSignature({ campus: 'saint-etienne', formation: null, associationId: null }, sig)
    ).not.toThrow();
    for (const selection of [
      { campus: 'gardanne', formation: null },
      { campus: 'saint-etienne', formation: 'ICM' },
      { campus: null, formation: 'ICM' },
    ] as const) {
      await expect(svc.signAgendaFeedSelection('staff-1', selection, null)).rejects.toMatchObject({
        response: { code: 'AGENDA_SELECTION_FORBIDDEN' },
      });
    }
  });

  it('refuses a campus to a reader with no campus, and to a student whose formation has no space', async () => {
    await expect(
      makeService([], { campus: null, cursus: [] }).signAgendaFeedSelection(
        'u',
        { campus: 'gardanne', formation: null },
        null
      )
    ).rejects.toMatchObject({ response: { code: 'AGENDA_SELECTION_FORBIDDEN' } });
    await expect(
      makeService([], {
        campus: 'gardanne',
        cursus: [{ formation: 'ICM', promo: 2021 }],
      }).signAgendaFeedSelection('u', { campus: 'gardanne', formation: null }, null)
    ).rejects.toMatchObject({ response: { code: 'AGENDA_SELECTION_FORBIDDEN' } });
  });

  it('signs an association for a reader with no space and no membership (membership never matters)', async () => {
    const svc = makeService([]);
    const id = '00000000-0000-4000-8000-000000000001';
    const { sig } = await svc.signAgendaFeedSelection(
      'user-1',
      { campus: null, formation: null },
      id
    );
    expect(() =>
      assertAgendaSignature({ campus: null, formation: null, associationId: id }, sig)
    ).not.toThrow();
  });
});
