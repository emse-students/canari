import { describe, expect, it } from 'vitest';
import { AssociationPermissionFlag, type Association } from '$lib/associations/api';
import type { PostEntity } from './api';
import {
  institutionAudienceWarning,
  pendingRequests,
  personalRequestCandidates,
  personalRequestRefusalMessage,
  proposalCandidates,
  republishCandidates,
  republishedByLine,
  republishedByText,
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

describe('republishedByText - "vous" first for the reader who reposted (owner, 2026-11-02)', () => {
  const marie = { id: 'm', name: 'Marie' };
  const yann = { id: 'y', name: 'Yann' };
  const bde = [{ id: 'b', name: 'BDE', slug: 'b', logoUrl: null }];

  it('says "vous" alone when nobody else is named', () => {
    expect(republishedByText([], [], true)).toBe(m.post_republished_by_you());
  });

  it('says "vous et X" with one other name', () => {
    expect(republishedByText([], [marie], true)).toBe(
      m.post_republished_by_you_and({ name: 'Marie' })
    );
    expect(republishedByText(bde, [], true)).toBe(m.post_republished_by_you_and({ name: 'BDE' }));
  });

  it('says "vous, X et N autres" beyond, associations still named first', () => {
    expect(republishedByText(bde, [marie, yann], true)).toBe(
      m.post_republished_by_you_and_more({ name: 'BDE', count: 2 })
    );
  });

  it('leaves the line of a reader who did not repost as it was', () => {
    expect(republishedByText([], [], false)).toBeNull();
    expect(republishedByText([], [marie])).toBe(m.post_republished_by({ names: 'Marie' }));
  });
});

describe('republishCandidates', () => {
  const POST_AS = AssociationPermissionFlag.POST_AS_ASSO;

  it('keeps only associations where the reader holds POST_AS_ASSO', () => {
    const mine = [asso('a', { permissions: POST_AS }), asso('b', { permissions: 0 })];
    expect(republishCandidates(mine, post, false).map((a) => a.id)).toEqual(['a']);
  });

  it('leaves out the post own association, a republisher, an archived one and an unlisted kind', () => {
    const mine = [
      asso('own', { permissions: POST_AS }),
      asso('done', { permissions: POST_AS }),
      asso('old', { permissions: POST_AS, archived: true }),
      asso('club', { permissions: POST_AS, type: 'club' as Association['type'] }),
      asso('ok', { permissions: POST_AS }),
    ];
    expect(republishCandidates(mine, post, false).map((a) => a.id)).toEqual(['ok']);
  });

  it('offers a campaign list, as the server accepts since 2026-10-31', () => {
    const list = asso('list', { permissions: POST_AS, type: 'list' });
    expect(republishCandidates([list], post, false).map((a) => a.id)).toEqual(['list']);
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
  it('offers every entity of a listed kind that does not carry the post yet', () => {
    const directory = [
      asso('own'),
      asso('done'),
      asso('x'),
      asso('l', { type: 'list' }),
      asso('club', { type: 'club' as Association['type'] }),
    ];
    expect(proposalCandidates(directory, post).map((a) => a.id)).toEqual(['x', 'l']);
  });
});

describe("institutionAudienceWarning - an institution's potential audience (owner, 2026-11-02)", () => {
  it('warns of nothing for a request that is not an institution', () => {
    expect(institutionAudienceWarning(null)).toEqual([]);
    expect(institutionAudienceWarning(undefined)).toEqual([]);
  });

  it('says everyone plainly, and the staff side when staff belong to it', () => {
    expect(
      institutionAudienceWarning({
        everyone: true,
        spaces: [{ campus: null, formation: null }],
        staffMembers: true,
      })
    ).toEqual([
      m.republication_requests_audience_everyone(),
      m.republication_requests_audience_members(),
      m.republication_requests_audience_staff(),
    ]);
  });

  it('names the spaces it reaches otherwise, a null side read as "every"', () => {
    const lines = institutionAudienceWarning({
      everyone: false,
      spaces: [
        { campus: 'gardanne', formation: null },
        { campus: 'saint-etienne', formation: 'ICM' },
      ],
      staffMembers: false,
    });
    expect(lines).toEqual([
      m.republication_requests_audience_spaces({
        spaces: [
          m.republication_requests_audience_space({
            formation: m.republication_requests_audience_any_formation(),
            campus: m.profile_campus_gardanne(),
          }),
          m.republication_requests_audience_space({
            formation: 'ICM',
            campus: m.profile_campus_saint_etienne(),
          }),
        ].join(', '),
      }),
      // Always said, also when it has rules (review of #2965).
      m.republication_requests_audience_members(),
    ]);
    expect(lines.join(' ')).not.toContain(m.republication_requests_audience_staff());
  });

  it('says it addresses no space, and that its members see it, when it has no rule', () => {
    expect(institutionAudienceWarning({ everyone: false, spaces: [], staffMembers: true })).toEqual(
      [
        m.republication_requests_audience_none(),
        m.republication_requests_audience_members(),
        m.republication_requests_audience_staff(),
      ]
    );
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

  it('offers every listed kind (owner, 2026-11-02), held POST_AS_ASSO, not archived, not carrying, not asked yet', () => {
    const mine = [
      asso('ok', { permissions: POST_AS }),
      asso('noflag', { permissions: 0 }),
      asso('inst', { permissions: POST_AS, type: 'institution' }),
      asso('list', { permissions: POST_AS, type: 'list' }),
      asso('club', { permissions: POST_AS, type: 'club' as Association['type'] }),
      asso('old', { permissions: POST_AS, archived: true }),
      asso('done', { permissions: POST_AS }),
      asso('waiting', { permissions: POST_AS }),
      asso('refused', { permissions: POST_AS }),
    ];
    expect(personalRequestCandidates(mine, personal).map((a) => a.id)).toEqual([
      'ok',
      'inst',
      'list',
    ]);
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
