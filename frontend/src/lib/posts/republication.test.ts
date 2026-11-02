import { describe, expect, it } from 'vitest';
import { AssociationPermissionFlag, type Association } from '$lib/associations/api';
import type { PostEntity } from './api';
import {
  pendingRequests,
  personalRequestCandidates,
  personalRequestRefusalMessage,
  proposalCandidates,
  republishCandidates,
  republishedByLine,
} from './republication';
import { m } from '$lib/paraglide/messages';

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

  it('names one and counts the rest, the line sharing the time row', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id, slug: id, logoUrl: null }));
    expect(republishedByLine(five)).toEqual({ names: ['a'], extra: 4 });
    expect(republishedByLine(five.slice(0, 1))).toEqual({ names: ['a'], extra: 0 });
  });

  it('names the people the reader follows who reposted it after the associations (WP-F6)', () => {
    const bde = [{ id: 'b', name: 'BDE', slug: 'b', logoUrl: null }];
    expect(republishedByLine([], [{ id: 'u', name: 'Yann' }])).toEqual({
      names: ['Yann'],
      extra: 0,
    });
    expect(republishedByLine(bde, [{ id: 'u', name: 'Yann' }])).toEqual({
      names: ['BDE'],
      extra: 1,
    });
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

describe('asking the author of a personal post (D38b)', () => {
  const POST_AS = AssociationPermissionFlag.POST_AS_ASSO;
  const personal = {
    id: 'p2',
    associationId: null,
    republishedBy: [{ id: 'done', name: 'DONE', slug: 'done', logoUrl: null }],
    republicationRequests: [
      { associationId: 'waiting', associationName: 'WAITING', proposalId: 'r1', status: 'pending' },
      { associationId: 'refused', associationName: 'REFUSED', proposalId: 'r2', status: 'refused' },
    ],
  } as unknown as PostEntity;

  it('offers only associations, held POST_AS_ASSO, not archived, not carrying, not asked yet', () => {
    const mine = [
      asso('ok', { permissions: POST_AS }),
      asso('noflag', { permissions: 0 }),
      asso('inst', { permissions: POST_AS, type: 'institution' }),
      asso('list', { permissions: POST_AS, type: 'list' }),
      asso('old', { permissions: POST_AS, archived: true }),
      asso('done', { permissions: POST_AS }),
      asso('waiting', { permissions: POST_AS }),
      asso('refused', { permissions: POST_AS }),
    ];
    expect(personalRequestCandidates(mine, personal).map((a) => a.id)).toEqual(['ok']);
  });

  it('names the requests still waiting, and leaves a refused one out', () => {
    expect(pendingRequests(personal)).toEqual([{ proposalId: 'r1', name: 'WAITING' }]);
    expect(pendingRequests({ id: 'p3' } as PostEntity)).toEqual([]);
  });

  it('reads a refusal by its code, and a bare 409 as a request that already stands', () => {
    expect(personalRequestRefusalMessage('REPOST_PERSONAL_ANONYMOUS', 400)).toBe(
      m.post_request_republication_refused_anonymous()
    );
    expect(personalRequestRefusalMessage('REPOST_PERSONAL_BLOCKED', 403)).toBe(
      m.post_request_republication_refused_blocked()
    );
    expect(personalRequestRefusalMessage('REPOST_PERSONAL_AUTHOR_CAP', 409)).toBe(
      m.post_request_republication_refused_author_cap()
    );
    expect(personalRequestRefusalMessage('REPOST_PERSONAL_ASSOCIATION_CAP', 409)).toBe(
      m.post_request_republication_refused_association_cap()
    );
    expect(personalRequestRefusalMessage(null, 409)).toBe(m.post_request_republication_conflict());
    expect(personalRequestRefusalMessage(null, null)).toBe(m.post_republish_error());
  });
});
