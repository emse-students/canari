import { ForbiddenException } from '@nestjs/common';
import {
  agendaSubscriptionToken,
  assertAgendaSignature,
  canonicalAgendaSelection,
  eventIcsSignatureMatches,
  legacyAgendaLinkShape,
  selectionWithinSpaces,
  signAgendaSelection,
  signEventIcs,
  verifiedAgendaSubscriptionId,
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

describe('the subscription token (2026-11-14)', () => {
  const previous = process.env.AGENDA_SIGNING_KEY;
  beforeAll(() => {
    process.env.AGENDA_SIGNING_KEY = KEY;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previous;
  });

  const ID = '00000000-0000-4000-8000-00000000a001';

  it('is `<id>.<HMAC>`, deterministic, and verifies back to its id', () => {
    const token = agendaSubscriptionToken(ID);
    expect(token.startsWith(`${ID}.`)).toBe(true);
    expect(agendaSubscriptionToken(ID)).toBe(token);
    expect(verifiedAgendaSubscriptionId(token)).toBe(ID);
    expect(verifiedAgendaSubscriptionId(` ${token} `)).toBe(ID);
  });

  it('refuses a tampered signature, a swapped id, a non-uuid and an empty token', () => {
    const token = agendaSubscriptionToken(ID);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const other = '00000000-0000-4000-8000-00000000a002';
    expect(verifiedAgendaSubscriptionId(flipped)).toBeNull();
    expect(verifiedAgendaSubscriptionId(`${other}.${token.split('.')[1]}`)).toBeNull();
    expect(verifiedAgendaSubscriptionId(`not-a-uuid.${token.split('.')[1]}`)).toBeNull();
    expect(verifiedAgendaSubscriptionId(ID)).toBeNull();
    expect(verifiedAgendaSubscriptionId('')).toBeNull();
    expect(verifiedAgendaSubscriptionId(undefined)).toBeNull();
  });

  it('is no selection signature and no event signature, and neither is one', () => {
    const token = agendaSubscriptionToken(ID);
    const hmac = token.split('.')[1];
    // A selection's `sig` or an event's put after the id is not a token...
    const selectionSig = signAgendaSelection({ campus: null, formation: null, associationId: ID });
    expect(verifiedAgendaSubscriptionId(`${ID}.${selectionSig}`)).toBeNull();
    expect(verifiedAgendaSubscriptionId(`${ID}.${signEventIcs(ID)}`)).toBeNull();
    // ...and a token's HMAC is no selection's nor event's signature.
    expect(() =>
      assertAgendaSignature({ campus: null, formation: null, associationId: ID }, hmac)
    ).toThrow(ForbiddenException);
    expect(eventIcsSignatureMatches(ID, hmac)).toBe(false);
  });

  it('dies with the key: a rotated key ends every token', () => {
    const token = agendaSubscriptionToken(ID);
    process.env.AGENDA_SIGNING_KEY = `${KEY}-rotated`;
    try {
      expect(verifiedAgendaSubscriptionId(token)).toBeNull();
    } finally {
      process.env.AGENDA_SIGNING_KEY = KEY;
    }
  });

  it('names the shape of a legacy selection link', () => {
    expect(legacyAgendaLinkShape({ campus: 'gardanne', formation: 'ICM' })).toBe('pair');
    expect(legacyAgendaLinkShape({ campus: 'gardanne', formation: null })).toBe('campus');
    expect(legacyAgendaLinkShape({ campus: null, formation: 'ICM' })).toBe('formation');
    expect(legacyAgendaLinkShape({ campus: null, formation: null })).toBe('association');
  });
});

describe('AssociationsService.subscribeAgenda (2026-11-14)', () => {
  const previous = process.env.AGENDA_SIGNING_KEY;
  beforeAll(() => {
    process.env.AGENDA_SIGNING_KEY = KEY;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previous;
  });

  const ID = '00000000-0000-4000-8000-00000000a001';

  function makeService(spaces: Array<{ campus: string; formation: string }>) {
    const query = jest.fn((sql: string) => {
      if (sql.includes('INSERT INTO agenda_subscriptions')) return Promise.resolve([]);
      if (sql.includes('FROM agenda_subscriptions')) return Promise.resolve([{ id: ID }]);
      if (sql.includes('FROM users WHERE')) return Promise.resolve([]);
      return Promise.resolve(spaces);
    });
    const svc = Object.create(AssociationsService.prototype) as AssociationsService;
    Object.assign(svc, {
      assoRepo: { manager: { query } },
      logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
      findById: jest.fn(() => Promise.resolve({})),
    });
    return { svc, query };
  }

  it('writes the row once and answers the token of the row it reads back', async () => {
    const { svc, query } = makeService([{ campus: 'gardanne', formation: 'ICM' }]);
    await expect(
      svc.subscribeAgenda('user-1', { campus: 'gardanne', formation: 'ICM' }, null)
    ).resolves.toEqual({ token: agendaSubscriptionToken(ID) });
    const statements = query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => /ON CONFLICT DO NOTHING/.test(s))).toBe(true);
  });

  it('refuses a selection outside the reader spaces and writes nothing', async () => {
    const { svc, query } = makeService([{ campus: 'gardanne', formation: 'ICM' }]);
    await expect(
      svc.subscribeAgenda('user-1', { campus: 'saint-etienne', formation: 'ICM' }, null)
    ).rejects.toMatchObject({ response: { code: 'AGENDA_SELECTION_FORBIDDEN' } });
    expect(query.mock.calls.some((c) => String(c[0]).includes('INSERT'))).toBe(false);
  });
});
