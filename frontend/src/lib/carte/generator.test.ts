import { describe, expect, it } from 'vitest';
import { bureauCrownAngle } from './layout';
import { buildPosterModel } from './generator';
import type { Association, AssociationCategory, AssociationMember } from '$lib/associations/api';

describe('carte generator', () => {
  it('uses the first roster member as president and keeps later admins in roster order', () => {
    const association = {
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
    const members = [
      {
        id: 'm-1',
        associationId: association.id,
        userId: 'user-a',
        displayName: 'Alice',
        role: 'Secrétaire',
        isAdmin: false,
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

  it('centers the bureau crown on the bottom card and rises outward to the sides', () => {
    expect(bureauCrownAngle(0, 3)).toBeCloseTo(Math.PI / 2);
    expect(bureauCrownAngle(1, 3)).toBeCloseTo((3 * Math.PI) / 4);
    expect(bureauCrownAngle(2, 3)).toBeCloseTo(Math.PI / 4);
  });
});
