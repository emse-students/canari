/// <reference types="jest" />

import { AuthSessionsService, ROTATION_GRACE_SECONDS } from './auth-sessions.service';
import { AuthSession } from './entities/auth-session.entity';

/**
 * In-memory stand-in for the TypeORM repository.
 *
 * It interprets the PARAMETERS of the two hand-written queries, never their SQL,
 * and throws on any string it does not recognise - so rewording a WHERE clause
 * fails the suite loudly instead of silently changing what is being tested.
 * What it cannot cover is the SQL itself (column quoting, the atomicity of the
 * conditional UPDATE); that is the database's job and is exercised in staging.
 */
class FakeRepo {
  rows: AuthSession[] = [];

  create(partial: Partial<AuthSession>): AuthSession {
    return { ...partial } as AuthSession;
  }

  save(row: AuthSession): Promise<AuthSession> {
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findOne(options: { where: { id: string; userId?: string } }): Promise<AuthSession | null> {
    const { id, userId } = options.where;
    return Promise.resolve(
      this.rows.find((r) => r.id === id && (userId === undefined || r.userId === userId)) ?? null
    );
  }

  update(
    criteria: { id: string; userId?: string },
    patch: Partial<AuthSession>
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const row of this.rows) {
      if (row.id !== criteria.id) continue;
      if (criteria.userId !== undefined && row.userId !== criteria.userId) continue;
      Object.assign(row, patch);
      affected++;
    }
    return Promise.resolve({ affected });
  }

  find(options: { where: { userId: string } }): Promise<AuthSession[]> {
    return Promise.resolve(this.rows.filter((r) => r.userId === options.where.userId));
  }

  delete(criteria: {
    id?: string;
    userId?: string;
    expiresAt?: { value?: Date };
  }): Promise<{ affected: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => {
      if (criteria.id !== undefined && r.id !== criteria.id) return true;
      if (criteria.userId !== undefined && r.userId !== criteria.userId) return true;
      // LessThan(date) - TypeORM wraps the bound value in `.value`.
      if (criteria.expiresAt !== undefined) {
        const cutoff = criteria.expiresAt.value as Date;
        return r.expiresAt.getTime() >= cutoff.getTime();
      }
      return false;
    });
    return Promise.resolve({ affected: before - this.rows.length });
  }

  createQueryBuilder(): FakeQueryBuilder {
    return new FakeQueryBuilder(this);
  }
}

const UPDATE_WHERE = 'id = :id AND "tokenId" = :presented AND "expiresAt" > :now';
const DELETE_WHERE = '"userId" = :userId';
const DELETE_AND_WHERE = 'id != :keep';

class FakeQueryBuilder {
  private mode: 'update' | 'delete' | null = null;
  private patch: Partial<AuthSession> = {};
  private params: Record<string, unknown> = {};

  constructor(private readonly repo: FakeRepo) {}

  update(): this {
    this.mode = 'update';
    return this;
  }

  set(patch: Partial<AuthSession>): this {
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  from(): this {
    return this;
  }

  where(sql: string, params: Record<string, unknown>): this {
    if (sql !== UPDATE_WHERE && sql !== DELETE_WHERE) {
      throw new Error(`FakeRepo does not know this WHERE clause: ${sql}`);
    }
    Object.assign(this.params, params);
    return this;
  }

  andWhere(sql: string, params: Record<string, unknown>): this {
    if (sql !== DELETE_AND_WHERE) {
      throw new Error(`FakeRepo does not know this AND clause: ${sql}`);
    }
    Object.assign(this.params, params);
    return this;
  }

  execute(): Promise<{ affected: number }> {
    if (this.mode === 'update') {
      const { id, presented, now } = this.params as {
        id: string;
        presented: string;
        now: Date;
      };
      const row = this.repo.rows.find(
        (r) => r.id === id && r.tokenId === presented && r.expiresAt.getTime() > now.getTime()
      );
      if (!row) return Promise.resolve({ affected: 0 });
      Object.assign(row, this.patch);
      return Promise.resolve({ affected: 1 });
    }

    const { userId, keep } = this.params as { userId: string; keep?: string };
    const before = this.repo.rows.length;
    this.repo.rows = this.repo.rows.filter(
      (r) => r.userId !== userId || (keep !== undefined && r.id === keep)
    );
    return Promise.resolve({ affected: before - this.repo.rows.length });
  }
}

function makeService(): { service: AuthSessionsService; repo: FakeRepo } {
  const repo = new FakeRepo();
  const service = new AuthSessionsService(repo as never);
  return { service, repo };
}

describe('AuthSessionsService', () => {
  describe('create', () => {
    it('opens a session with a distinct id and token id', async () => {
      const { service, repo } = makeService();
      const a = await service.create('user-1', {
        userAgent: 'Firefox',
        ip: '10.0.0.1',
      });
      const b = await service.create('user-1');

      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.tokenId).not.toBe(a.sessionId);
      expect(repo.rows).toHaveLength(2);
      expect(repo.rows[0].userAgent).toBe('Firefox');
      expect(repo.rows[0].lastIp).toBe('10.0.0.1');
      expect(a.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('truncates an oversized User-Agent to the column width', async () => {
      const { service, repo } = makeService();
      await service.create('user-1', { userAgent: 'x'.repeat(400) });
      expect(repo.rows[0].userAgent).toHaveLength(255);
    });

    it('stores an empty User-Agent as null rather than an empty string', async () => {
      const { service, repo } = makeService();
      await service.create('user-1', { userAgent: '   ' });
      expect(repo.rows[0].userAgent).toBeNull();
    });
  });

  describe('rotate', () => {
    it('accepts the current token and issues a different one', async () => {
      const { service } = makeService();
      const opened = await service.create('user-1');

      const result = await service.rotate(opened.sessionId, opened.tokenId);

      expect(result.status).toBe('rotated');
      if (result.status !== 'rotated') return;
      expect(result.tokenId).not.toBe(opened.tokenId);
    });

    it('refuses the token it just replaced once the grace window has passed', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');
      await service.rotate(opened.sessionId, opened.tokenId);

      // Age the rotation past the grace window.
      repo.rows[0].rotatedAt = new Date(Date.now() - (ROTATION_GRACE_SECONDS + 1) * 1000);

      const replay = await service.rotate(opened.sessionId, opened.tokenId);

      expect(replay.status).toBe('replayed');
      // Revoked, not merely refused: two holders share the cookie, so the
      // legitimate one must be forced back through a login too.
      expect(repo.rows).toHaveLength(0);
    });

    it('accepts the replaced token inside the grace window and hands back the current one', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');
      const first = await service.rotate(opened.sessionId, opened.tokenId);
      expect(first.status).toBe('rotated');

      // A second tab that read the cookie before the rotation landed.
      const concurrent = await service.rotate(opened.sessionId, opened.tokenId);

      expect(concurrent.status).toBe('reissued');
      if (concurrent.status !== 'reissued') return;
      if (first.status !== 'rotated') return;
      expect(concurrent.tokenId).toBe(first.tokenId);
      expect(repo.rows).toHaveLength(1);
    });

    it('does not rotate again inside the grace window', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');
      await service.rotate(opened.sessionId, opened.tokenId);
      const afterFirst = repo.rows[0].tokenId;

      await service.rotate(opened.sessionId, opened.tokenId);

      expect(repo.rows[0].tokenId).toBe(afterFirst);
    });

    it('refuses a token whose session was revoked', async () => {
      const { service } = makeService();
      const opened = await service.create('user-1');
      await service.revoke(opened.sessionId);

      const result = await service.rotate(opened.sessionId, opened.tokenId);

      expect(result.status).toBe('unknown');
    });

    it('refuses an expired session without destroying anything else', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');
      repo.rows[0].expiresAt = new Date(Date.now() - 1000);

      const result = await service.rotate(opened.sessionId, opened.tokenId);

      expect(result.status).toBe('unknown');
    });

    it('refuses a token that names a session belonging to nobody', async () => {
      const { service } = makeService();
      const result = await service.rotate('00000000-0000-4000-8000-000000000000', 'whatever');
      expect(result.status).toBe('unknown');
    });

    it('records the client facts of the latest refresh', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1', {
        userAgent: 'Firefox',
        ip: '10.0.0.1',
      });

      await service.rotate(opened.sessionId, opened.tokenId, {
        userAgent: 'Chrome',
        ip: '10.0.0.2',
      });

      expect(repo.rows[0].userAgent).toBe('Chrome');
      expect(repo.rows[0].lastIp).toBe('10.0.0.2');
    });
  });

  describe('revocation', () => {
    it('revokes a session owned by the caller', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');

      await expect(service.revokeOwned('user-1', opened.sessionId)).resolves.toBe(true);
      expect(repo.rows).toHaveLength(0);
    });

    it('refuses to revoke a session owned by someone else', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');

      await expect(service.revokeOwned('user-2', opened.sessionId)).resolves.toBe(false);
      expect(repo.rows).toHaveLength(1);
    });

    it('revokes every other session of the user and keeps the current one', async () => {
      const { service, repo } = makeService();
      const keep = await service.create('user-1');
      await service.create('user-1');
      await service.create('user-1');
      const other = await service.create('user-2');

      await expect(service.revokeOthers('user-1', keep.sessionId)).resolves.toBe(2);

      expect(repo.rows.map((r) => r.id).sort()).toEqual([keep.sessionId, other.sessionId].sort());
    });

    it('revokes all of the user sessions when no current one is given', async () => {
      const { service, repo } = makeService();
      await service.create('user-1');
      await service.create('user-1');

      await expect(service.revokeOthers('user-1', null)).resolves.toBe(2);
      expect(repo.rows).toHaveLength(0);
    });
  });

  describe('listForUser', () => {
    it('returns only the caller sessions', async () => {
      const { service } = makeService();
      await service.create('user-1');
      await service.create('user-2');

      const list = await service.listForUser('user-1');

      expect(list).toHaveLength(1);
      expect(list[0].id).toBeDefined();
    });

    it('hides a row that is past its deadline but not swept yet', async () => {
      const { service, repo } = makeService();
      await service.create('user-1');
      await service.create('user-1');
      repo.rows[0].expiresAt = new Date(Date.now() - 1000);

      await expect(service.listForUser('user-1')).resolves.toHaveLength(1);
    });
  });

  describe('bindDevice', () => {
    it('records the device on the caller own session, and reports it in the list', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');

      await expect(service.bindDevice('user-1', opened.sessionId, 'web-a-b')).resolves.toBe(true);
      expect(repo.rows[0].deviceId).toBe('web-a-b');
      await expect(service.listForUser('user-1')).resolves.toEqual([
        expect.objectContaining({ deviceId: 'web-a-b' }),
      ]);
    });

    it('never stamps a device onto another user session', async () => {
      // The whole scope of the column: it is a label a client asserts about itself, so the only
      // session it may reach is the one the caller is already authenticated on.
      const { service, repo } = makeService();
      const victim = await service.create('user-2');

      await expect(service.bindDevice('user-1', victim.sessionId, 'web-a-b')).resolves.toBe(false);
      expect(repo.rows[0].deviceId).toBeUndefined();
    });

    it('writes NOTHING when the session already names that device', async () => {
      // An app restart re-states what the row already holds. A write per start would be one
      // needless UPDATE per device per launch, on the busiest table in the service.
      const { service, repo } = makeService();
      const opened = await service.create('user-1');
      await service.bindDevice('user-1', opened.sessionId, 'web-a-b');
      const writes = jest.spyOn(repo, 'update');

      await expect(service.bindDevice('user-1', opened.sessionId, 'web-a-b')).resolves.toBe(true);
      expect(writes).not.toHaveBeenCalled();
    });

    it('re-binds when the device really changed, because one browser can re-enrol', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1');
      await service.bindDevice('user-1', opened.sessionId, 'web-a-b');

      await expect(service.bindDevice('user-1', opened.sessionId, 'web-c-d')).resolves.toBe(true);
      expect(repo.rows[0].deviceId).toBe('web-c-d');
    });

    it('refuses an empty or oversized identifier rather than truncating it', async () => {
      // Truncating would store a PREFIX, which joins against the wrong device or against none -
      // and reads on the panel as a device the user does not have.
      const { service, repo } = makeService();
      const opened = await service.create('user-1');

      await expect(service.bindDevice('user-1', opened.sessionId, '   ')).resolves.toBe(false);
      await expect(service.bindDevice('user-1', opened.sessionId, 'x'.repeat(129))).resolves.toBe(
        false
      );
      expect(repo.rows[0].deviceId).toBeUndefined();
    });
  });

  describe('deleteExpired', () => {
    it('drops expired rows and leaves live ones', async () => {
      const { service, repo } = makeService();
      await service.create('user-1');
      await service.create('user-1');
      repo.rows[0].expiresAt = new Date(Date.now() - 1000);

      await expect(service.deleteExpired()).resolves.toBe(1);
      expect(repo.rows).toHaveLength(1);
    });
  });
});
