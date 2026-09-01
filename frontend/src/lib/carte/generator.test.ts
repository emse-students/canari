import { bureauCrownOffset } from './layout';
import { buildPosterModel, orderByFamilyName, type PosterMemberRef } from './generator';
import type { Association, AssociationCategory, AssociationMember } from '$lib/associations/api';

/** The one association every test in this file groups its roster under. */
function assoFixture(): Association {
  return {
    id: 'asso-1',
    name: 'Association Test',
    slug: 'asso-test',
    description: null,
    bioMarkdown: null,
    logoUrl: null,
    stripeAccountId: null,
    stripeOnboardingComplete: false,
    isBDE: false,
    documentQuotaBytes: 0,
    createdBy: 'user-0',
    type: 'association',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Association;
}

describe('carte generator', () => {
  it('uses the first roster member as president and keeps later admins in roster order', () => {
    const association = assoFixture();
    const members = [
      {
        id: 'm-1',
        associationId: association.id,
        userId: 'user-a',
        displayName: 'Alice',
        role: 'Présidente',
        isAdmin: true,
        sortOrder: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'm-2',
        associationId: association.id,
        userId: 'user-b',
        displayName: 'Bob',
        role: 'Président',
        isAdmin: true,
        sortOrder: 2,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'm-3',
        associationId: association.id,
        userId: 'user-c',
        displayName: 'Cara',
        role: 'Trésorière',
        isAdmin: true,
        sortOrder: 3,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ] as AssociationMember[];

    const model = buildPosterModel(
      [association],
      [] as AssociationCategory[],
      { [association.id]: members },
      'Autre'
    );

    const bubble = model.zones[0].bubbles[0];
    expect(bubble.president?.userId).toBe('user-a');
    expect(bubble.bureau.map((member) => member.userId)).toEqual(['user-b', 'user-c']);
  });

  it('carries the name parts onto every roster reference', () => {
    const model = buildPosterModel(
      [assoFixture()],
      [] as AssociationCategory[],
      {
        'asso-1': [
          {
            id: 'm-1',
            associationId: 'asso-1',
            userId: 'user-a',
            displayName: 'Alice Martin',
            firstName: 'Alice',
            lastName: 'Martin',
            role: 'Presidente',
            isAdmin: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ] as AssociationMember[],
      },
      'Autre'
    );
    expect(model.zones[0].bubbles[0].members[0]).toMatchObject({
      name: 'Alice Martin',
      firstName: 'Alice',
      lastName: 'Martin',
    });
  });

  it('orders a roster by family name, then given name', () => {
    const ref = (userId: string, name: string, firstName: string | null, lastName: string | null) =>
      ({ userId, name, firstName, lastName, role: '', isAdmin: false }) as PosterMemberRef;
    const ordered = orderByFamilyName([
      ref('u1', 'Alice Martin', 'Alice', 'Martin'),
      ref('u2', 'Zoe Bernard', 'Zoe', 'Bernard'),
      ref('u3', 'Yves Martin', 'Yves', 'Martin'),
      // No family name on record: sorts under the name that is printed for them.
      ref('u4', 'Casimir', null, null),
      // A compound surname keeps its first particle - splitting the display name would lose it.
      ref('u5', 'Paul Van Dupont', 'Paul', 'Van Dupont'),
    ]);
    expect(ordered.map((mem) => mem.userId)).toEqual(['u2', 'u4', 'u1', 'u3', 'u5']);
  });

  it('places the bureau crown according to the fixed angles', () => {
    expect(bureauCrownOffset(0).x).toBeCloseTo(-78.54, 2);
    expect(bureauCrownOffset(0).y).toBeCloseTo(110.44, 2);
    expect(bureauCrownOffset(1).x).toBeCloseTo(78.54, 2);
    expect(bureauCrownOffset(1).y).toBeCloseTo(110.44, 2);
    expect(bureauCrownOffset(2).x).toBeCloseTo(-118.28, 2);
    expect(bureauCrownOffset(2).y).toBeCloseTo(16.14, 2);
  });
});
