import { describe, expect, it } from 'vitest';
import { AssociationPermissionFlag, type Association } from '$lib/associations/api';
import type { PostEntity } from './api';
import { proposalCandidates, republishCandidates, republishedByLine } from './republication';

function asso(id: string, extra: Partial<Association> = {}): Association {
  return {
    id,
    name: id.toUpperCase(),
    slug: id,
    type: 'association',
    archived: false,
    ...extra,
  } as Association;
}

const post = {
  id: 'p1',
  associationId: 'own',
  republishedBy: [{ id: 'done', name: 'DONE', slug: 'done', logoUrl: null }],
} as PostEntity;

describe('republishedByLine', () => {
  it('draws nothing when nobody republished', () => {
    expect(republishedByLine(undefined)).toBeNull();
    expect(republishedByLine([])).toBeNull();
  });

  it('names three and counts the rest', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id, slug: id, logoUrl: null }));
    expect(republishedByLine(five)).toEqual({ names: ['a', 'b', 'c'], extra: 2 });
    expect(republishedByLine(five.slice(0, 2))).toEqual({ names: ['a', 'b'], extra: 0 });
  });
});

describe('republishCandidates', () => {
  const POST_AS = AssociationPermissionFlag.POST_AS_ASSO;

  it('keeps only associations where the reader holds POST_AS_ASSO', () => {
    const mine = [asso('a', { permissions: POST_AS }), asso('b', { permissions: 0 })];
    expect(republishCandidates(mine, post, false).map((a) => a.id)).toEqual(['a']);
  });

  it('leaves out the post own association, a republisher, a list and an archived one', () => {
    const mine = [
      asso('own', { permissions: POST_AS }),
      asso('done', { permissions: POST_AS }),
      asso('list', { permissions: POST_AS, type: 'list' }),
      asso('old', { permissions: POST_AS, archived: true }),
      asso('ok', { permissions: POST_AS }),
    ];
    expect(republishCandidates(mine, post, false).map((a) => a.id)).toEqual(['ok']);
  });

  it('hands a global admin every association, flags aside', () => {
    expect(republishCandidates([asso('x')], post, true).map((a) => a.id)).toEqual(['x']);
  });
});

describe('institutions republish like associations (WP6e)', () => {
  it('offers an institution in both lists, an archived one in neither', () => {
    const inst = asso('inst', {
      type: 'institution',
      permissions: AssociationPermissionFlag.POST_AS_ASSO,
    });
    const old = asso('old', { type: 'institution', archived: true });
    expect(republishCandidates([inst, old], post, false).map((a) => a.id)).toEqual(['inst']);
    expect(proposalCandidates([inst, old], post).map((a) => a.id)).toEqual(['inst']);
  });
});

describe('proposalCandidates', () => {
  it('offers every association that does not carry the post yet', () => {
    const directory = [asso('own'), asso('done'), asso('x'), asso('l', { type: 'list' })];
    expect(proposalCandidates(directory, post).map((a) => a.id)).toEqual(['x']);
  });
});
