import { NotFoundException } from '@nestjs/common';
import { FollowsService } from './follows.service';

/**
 * The follow rules the service itself owns, against in-memory repositories (the repo's pattern, see
 * association-push-mutes.service.spec.ts). Deliberately NOT pinned, because the service does not do
 * them: refusing a self-follow (the controller does), blocks, a counts API and a visibility rule
 * for a follow list. Those absences are recorded in docs/wiki/mechanism-audit.md rather than frozen
 * here as if intended. The SQL readers' `status = 'accepted'` term is proven against PostgreSQL
 * (`follows/user-follow-status.integration.spec.ts`, `spaces/reader-spaces.integration.spec.ts`).
 */
type Row = {
  followerUserId: string;
  associationId?: string;
  followedUserId?: string;
  status?: string;
};

function matches(row: Row, where: Partial<Row>): boolean {
  return Object.entries(where).every(([k, v]) => row[k as keyof Row] === v);
}

function fakeRepo(rows: Row[]) {
  return {
    findOne: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null)
    ),
    find: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)))
    ),
    count: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length)
    ),
    // The one raw statement the service sends: `recordFollowRequest`'s INSERT ... ON CONFLICT DO
    // NOTHING RETURNING status. Its real behaviour under concurrency is proven against PostgreSQL
    // in `user-follow-status.integration.spec.ts`; this stands in for its single-caller semantics.
    query: jest.fn((sql: string, params: string[]) => {
      if (!/^\s*INSERT INTO user_follows/.test(sql)) throw new Error(`unexpected SQL: ${sql}`);
      const [, followerUserId, followedUserId, status] = params;
      if (rows.some((r) => matches(r, { followerUserId, followedUserId }))) {
        return Promise.resolve([]);
      }
      rows.push({ followerUserId, followedUserId, status });
      return Promise.resolve([{ status }]);
    }),
    create: jest.fn((row: Row) => ({ ...row })),
    save: jest.fn((row: Row) => {
      rows.push(row);
      return Promise.resolve(row);
    }),
    delete: jest.fn((where: Partial<Row>) => {
      const keep = rows.filter((r) => !matches(r, where));
      const affected = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return Promise.resolve({ affected });
    }),
  };
}

describe('FollowsService', () => {
  const assoRows: Row[] = [];
  const userRows: Row[] = [];
  const assos = [
    { id: 'a1', name: 'Alpha', slug: 'alpha', logoUrl: null, extra: 'dropped' },
    { id: 'a2', name: 'Beta', slug: 'beta', logoUrl: 'b.png', extra: 'dropped' },
  ];
  const assoRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(assos.find((a) => a.id === where.id) ?? null)
    ),
    findBy: jest.fn(({ id }: { id: { _value: string[] } }) =>
      Promise.resolve(assos.filter((a) => id._value.includes(a.id)))
    ),
  };

  function service() {
    return new FollowsService(
      fakeRepo(assoRows) as never,
      fakeRepo(userRows) as never,
      assoRepo as never
    );
  }

  beforeEach(() => {
    assoRows.length = 0;
    userRows.length = 0;
    jest.clearAllMocks();
  });

  describe('association follows', () => {
    it('follows once however many times it is asked (idempotent)', async () => {
      expect(await service().followAssociation('u1', 'a1')).toEqual({ ok: true });
      expect(await service().followAssociation('u1', 'a1')).toEqual({ ok: true });
      expect(assoRows).toEqual([{ followerUserId: 'u1', associationId: 'a1' }]);
    });

    it('refuses an association that does not exist, and writes nothing', async () => {
      await expect(service().followAssociation('u1', 'nope')).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(assoRows).toEqual([]);
    });

    it('unfollows, and refuses a second unfollow with a typed not-found', async () => {
      await service().followAssociation('u1', 'a1');
      expect(await service().unfollowAssociation('u1', 'a1')).toEqual({ ok: true });
      expect(await service().isFollowing('u1', 'a1')).toBe(false);
      await expect(service().unfollowAssociation('u1', 'a1')).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('keeps each follower apart: one user unfollowing never removes another follow', async () => {
      await service().followAssociation('u1', 'a1');
      await service().followAssociation('u2', 'a1');
      await service().unfollowAssociation('u1', 'a1');
      expect(await service().isFollowing('u2', 'a1')).toBe(true);
      expect(await service().getFollowedAssociationIdsForUser('u1')).toEqual([]);
      expect(await service().getFollowedAssociationIdsForUser('u2')).toEqual(['a1']);
    });

    it('lists the followed associations as id, name, slug and logo only', async () => {
      await service().followAssociation('u1', 'a2');
      expect(await service().listFollowedAssociations('u1')).toEqual([
        { id: 'a2', name: 'Beta', slug: 'beta', logoUrl: 'b.png' },
      ]);
    });

    it('lists nothing without asking the association table when the user follows none', async () => {
      expect(await service().listFollowedAssociations('u1')).toEqual([]);
      expect(assoRepo.findBy).not.toHaveBeenCalled();
    });
  });

  describe('user follows (every person is private: a follow is a request first, WP-F1)', () => {
    /** The followed person's yes - written here by hand until WP-F2 gives it a route. */
    function accept(followerUserId: string, followedUserId: string) {
      const row = userRows.find(
        (r) => r.followerUserId === followerUserId && r.followedUserId === followedUserId
      );
      if (!row) throw new Error('no request to accept');
      row.status = 'accepted';
    }

    it('a follow of a person lands PENDING, and a request is not a follow', async () => {
      expect(await service().followUser('u1', 'u2')).toEqual({ ok: true, status: 'pending' });
      expect(userRows).toEqual([{ followerUserId: 'u1', followedUserId: 'u2', status: 'pending' }]);
      expect(await service().userFollowStatus('u1', 'u2')).toBe('pending');
      // Nothing that means "u1 follows u2" counts it: the Suivis feed reads no pending row.
      expect(await service().getFollowedUserIdsForUser('u1')).toEqual([]);
    });

    it('asks once however many times it is asked, and never turns a follow back into a request', async () => {
      await service().followUser('u1', 'u2');
      expect(await service().followUser('u1', 'u2')).toEqual({ ok: true, status: 'pending' });
      expect(userRows).toHaveLength(1);
      accept('u1', 'u2');
      expect(await service().followUser('u1', 'u2')).toEqual({ ok: true, status: 'accepted' });
      expect(userRows).toEqual([
        { followerUserId: 'u1', followedUserId: 'u2', status: 'accepted' },
      ]);
      expect(await service().getFollowedUserIdsForUser('u1')).toEqual(['u2']);
    });

    it('is directional: following does not make the other side follow back', async () => {
      await service().followUser('u1', 'u2');
      accept('u1', 'u2');
      expect(await service().userFollowStatus('u2', 'u1')).toBeNull();
      expect(await service().getFollowedUserIdsForUser('u2')).toEqual([]);
      expect(await service().getFollowedUserIdsForUser('u1')).toEqual(['u2']);
    });

    it('withdraws a pending request and unfollows an accepted one, then refuses with a typed not-found', async () => {
      await service().followUser('u1', 'u2');
      expect(await service().unfollowUser('u1', 'u2')).toEqual({ ok: true });
      expect(await service().userFollowStatus('u1', 'u2')).toBeNull();
      await service().followUser('u1', 'u2');
      accept('u1', 'u2');
      expect(await service().unfollowUser('u1', 'u2')).toEqual({ ok: true });
      await expect(service().unfollowUser('u1', 'u2')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('keeps each follower apart: one user unfollowing never removes another follow', async () => {
      await service().followUser('u1', 'u2');
      await service().followUser('u3', 'u2');
      accept('u3', 'u2');
      await service().unfollowUser('u1', 'u2');
      expect(await service().userFollowStatus('u3', 'u2')).toBe('accepted');
      expect(await service().userFollowStatus('u1', 'u2')).toBeNull();
    });

    it('does not mix the two follow kinds: an association is followed at once, with no request', async () => {
      await service().followUser('u1', 'u2');
      await service().followAssociation('u1', 'a1');
      // The person's follow waits for an answer; the association's is a follow at once.
      expect(await service().getFollowedUserIdsForUser('u1')).toEqual([]);
      expect(await service().getFollowedAssociationIdsForUser('u1')).toEqual(['a1']);
      accept('u1', 'u2');
      expect(await service().getFollowedUserIdsForUser('u1')).toEqual(['u2']);
      await service().unfollowUser('u1', 'u2');
      expect(await service().isFollowing('u1', 'a1')).toBe(true);
    });
  });
});
