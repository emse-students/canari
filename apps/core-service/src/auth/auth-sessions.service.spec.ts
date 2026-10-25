/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';

import {
  AuthSessionsService,
  DEVICE_ID_PATTERN,
  ROTATION_GRACE_SECONDS,
  SESSION_TTL_SECONDS,
  SWEEP_INTERVAL_MS,
} from './auth-sessions.service';
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
/** The only columns any hand-written WHERE in this service filters on. */
interface SessionWhere {
  id?: string;
  userId?: string;
  deviceId?: string;
}

const KNOWN_WHERE_KEYS = new Set(['id', 'userId', 'deviceId']);

/**
 * Applies one WHERE clause, and refuses any column the service is not supposed
 * to filter on - so widening a query fails the suite instead of quietly working.
 */
function matchesWhere(row: AuthSession, clause: SessionWhere): boolean {
  for (const key of Object.keys(clause)) {
    if (!KNOWN_WHERE_KEYS.has(key)) throw new Error(`Unrecognised WHERE column: ${key}`);
  }
  if (clause.id !== undefined && row.id !== clause.id) return false;
  if (clause.userId !== undefined && row.userId !== clause.userId) return false;
  if (clause.deviceId !== undefined && row.deviceId !== clause.deviceId) return false;
  return true;
}

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

  /**
   * Supports both shapes the service issues: one clause, and the ARRAY form -
   * an OR - that `bindDevice` uses to read its own row and every session already
   * claiming the device in a single round trip. Matches are de-duplicated by
   * identity, as the database would when a row satisfies both clauses.
   */
  find(options: { where: SessionWhere | SessionWhere[] }): Promise<AuthSession[]> {
    const clauses = Array.isArray(options.where) ? options.where : [options.where];
    const matched = this.rows.filter((r) => clauses.some((c) => matchesWhere(r, c)));
    return Promise.resolve([...new Set(matched)]);
  }

  delete(criteria: {
    id?: string | { value?: string[] };
    userId?: string;
    expiresAt?: { value?: Date };
  }): Promise<{ affected: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => {
      // `In([...])` - TypeORM wraps the bound list in `.value`, as `LessThan` does its date.
      if (criteria.id !== undefined) {
        const ids = typeof criteria.id === 'string' ? [criteria.id] : (criteria.id.value ?? []);
        if (!ids.includes(r.id)) return true;
      }
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

  /**
   * The transaction a revocation runs: every repository it asks for is this one, and a callback
   * that throws restores the rows it saw, as a rollback would.
   */
  get manager(): { transaction: <T>(cb: (m: unknown) => Promise<T>) => Promise<T> } {
    return {
      transaction: async <T>(cb: (m: unknown) => Promise<T>): Promise<T> => {
        const snapshot = [...this.rows];
        try {
          return await cb({ getRepository: () => this });
        } catch (e) {
          this.rows = snapshot;
          throw e;
        }
      },
    };
  }
}

const UPDATE_WHERE = 'id = :id AND "tokenId" = :presented AND "expiresAt" > :now';
const DELETE_WHERE = '"userId" = :userId';
const DELETE_AND_WHERE = 'id != :keep';

class FakeQueryBuilder {
  private mode: 'update' | 'delete' | null = null;
  private patch: Partial<AuthSession> = {};
  private params: Record<string, unknown> = {};
  private returned: string[] = [];

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

  returning(columns: string[]): this {
    this.returned = columns;
    return this;
  }

  execute(): Promise<{ affected: number; raw?: Array<Record<string, unknown>> }> {
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
    const deleted = (r: AuthSession) =>
      r.userId === userId && (keep === undefined || r.id !== keep);
    // RETURNING: the deleted rows, reduced to the columns asked for, as the driver hands them back.
    const raw = this.repo.rows
      .filter(deleted)
      .map((r) =>
        Object.fromEntries(
          this.returned.map((c) => [c, (r as unknown as Record<string, unknown>)[c]])
        )
      );
    this.repo.rows = this.repo.rows.filter((r) => !deleted(r));
    return Promise.resolve({ affected: raw.length, raw });
  }
}

/** Records every push ending the service queued, and every drain it started after a commit. */
function makeService(): {
  service: AuthSessionsService;
  repo: FakeRepo;
  enqueue: jest.Mock;
  drain: jest.Mock;
  queued: () => string[];
} {
  const repo = new FakeRepo();
  const enqueue = jest.fn((_manager: unknown, ended: unknown[], _cause: string) =>
    Promise.resolve(ended.length)
  );
  const drain = jest.fn(() => Promise.resolve());
  const service = new AuthSessionsService(repo as never, { enqueue, drain } as never);
  const queued = () =>
    enqueue.mock.calls.flatMap(([, ended, cause]) =>
      (ended as Array<{ id: string; userId: string; deviceId?: string | null }>).map(
        (row) => `${row.userId}/${row.deviceId ?? 'unnamed'}/${row.id}/${cause}`
      )
    );
  return { service, repo, enqueue, drain, queued };
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

    // Two causes end in the same revocation and only this line tells them apart: a client that LOST
    // the response of its last rotation (the previous token, outside the window - a suspended phone)
    // and a token that was spent TWO rotations ago (a real fork of the credential).
    it('names which kind of replay revoked the session, and how long ago the rotation was', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { service, repo } = makeService();
      const first = await service.create('user-1');
      const second = await service.rotate(first.sessionId, first.tokenId);
      if (second.status !== 'rotated') throw new Error('setup');
      repo.rows[0].rotatedAt = new Date(Date.now() - 600 * 1000);
      await service.rotate(first.sessionId, first.tokenId);
      const previousLine = String(warn.mock.calls.at(-1)?.[0]);
      expect(previousLine).toContain('presented=previous');
      expect(previousLine).toMatch(/rotatedAgo=6\d\ds/);

      const again = await service.create('user-1');
      const r1 = await service.rotate(again.sessionId, again.tokenId);
      if (r1.status !== 'rotated') throw new Error('setup');
      await service.rotate(again.sessionId, r1.tokenId);
      await service.rotate(again.sessionId, again.tokenId);
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('presented=older');
      warn.mockRestore();
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

    // The caller signs the device out on `unknown`, so the refusal must leave a line naming which
    // of the two it was - it was the only silent one (2026-09-28, a dev database replaced under it).
    it('says whether a refused session was missing or expired', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { service, repo } = makeService();
      await service.rotate('00000000-0000-4000-8000-000000000000', 'whatever');
      const opened = await service.create('user-1');
      repo.rows[0].expiresAt = new Date(Date.now() - 1000);
      await service.rotate(opened.sessionId, opened.tokenId);

      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines.some((l) => l.includes('no such session'))).toBe(true);
      expect(lines.some((l) => l.includes('session expired'))).toBe(true);
      warn.mockRestore();
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
    it('reads a session live for its owner until the owner revokes it', async () => {
      const { service } = makeService();
      const opened = await service.create('user-1');

      await expect(service.isLive(opened.sessionId, 'user-1')).resolves.toBe(true);
      // Another account naming the id is not its owner.
      await expect(service.isLive(opened.sessionId, 'user-2')).resolves.toBe(false);

      await service.revokeOwned('user-1', opened.sessionId);
      await expect(service.isLive(opened.sessionId, 'user-1')).resolves.toBe(false);
    });

    it('reads an idle-expired row as ended even before the sweep removes it', async () => {
      const { service } = makeService();
      const opened = await service.create('user-1');
      const later = new Date(opened.expiresAt.getTime() + 1);

      await expect(service.isLive(opened.sessionId, 'user-1', later)).resolves.toBe(false);
    });
  });

  describe('a session that ends records its push ending in the same transaction', () => {
    /** Opens a session of `userId` bound to `deviceId`. */
    async function boundSession(
      service: AuthSessionsService,
      userId: string,
      deviceId: string
    ): Promise<string> {
      const opened = await service.create(userId);
      await service.bindDevice(userId, opened.sessionId, deviceId);
      return opened.sessionId;
    }

    it('logout records the ending of the session it deleted, then drains', async () => {
      const { service, queued, drain } = makeService();
      const sid = await boundSession(service, 'user-1', 'phone-1');

      await service.revoke(sid);

      expect(queued()).toEqual([`user-1/phone-1/${sid}/logout`]);
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('the owner revoking a device records that session ending', async () => {
      const { service, queued } = makeService();
      const sid = await boundSession(service, 'user-1', 'phone-1');

      await expect(service.revokeOwned('user-1', sid)).resolves.toBe(true);

      expect(queued()).toEqual([`user-1/phone-1/${sid}/revoked-by-owner`]);
    });

    it('a refused revocation of someone else session records nothing', async () => {
      const { service, queued, drain } = makeService();
      const sid = await boundSession(service, 'user-2', 'phone-2');

      await expect(service.revokeOwned('user-1', sid)).resolves.toBe(false);

      expect(queued()).toEqual([]);
      expect(drain).not.toHaveBeenCalled();
    });

    it('revoking the other sessions records each one, and never the kept session', async () => {
      const { service, queued } = makeService();
      const keep = await boundSession(service, 'user-1', 'phone-1');
      const laptop = await boundSession(service, 'user-1', 'laptop-1');
      const tab = await service.create('user-1');
      await boundSession(service, 'user-2', 'phone-2');

      await service.revokeOthers('user-1', keep);

      expect(queued().sort()).toEqual(
        [
          `user-1/laptop-1/${laptop}/revoked-others`,
          `user-1/unnamed/${tab.sessionId}/revoked-others`,
        ].sort()
      );
    });

    it('a replayed refresh token, which revokes the session, records its ending', async () => {
      const { service, repo, queued } = makeService();
      const opened = await service.create('user-1');
      await service.bindDevice('user-1', opened.sessionId, 'phone-1');
      // Two rotations: the original token is now neither current nor inside the grace window.
      const first = await service.rotate(opened.sessionId, opened.tokenId);
      if (first.status !== 'rotated') throw new Error('expected a rotation');
      await service.rotate(opened.sessionId, first.tokenId);

      await expect(service.rotate(opened.sessionId, opened.tokenId)).resolves.toEqual({
        status: 'replayed',
      });

      expect(repo.rows).toHaveLength(0);
      expect(queued()).toEqual([`user-1/phone-1/${opened.sessionId}/replay`]);
    });

    it('a session that never named a device is still recorded: it may have registered before it did', async () => {
      const { service, queued, drain } = makeService();
      const opened = await service.create('user-1');

      await service.revoke(opened.sessionId);

      expect(queued()).toEqual([`user-1/unnamed/${opened.sessionId}/logout`]);
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('a logout of a session already gone records nothing', async () => {
      const { service, enqueue } = makeService();
      await service.revoke('00000000-0000-4000-8000-000000000000');
      expect(enqueue.mock.calls.every(([, ended]) => (ended as unknown[]).length === 0)).toBe(true);
    });

    it('binding a device revokes its strays without recording an ending', async () => {
      const { service, queued } = makeService();
      await boundSession(service, 'user-1', 'phone-1');
      await boundSession(service, 'user-1', 'phone-1');

      expect(queued()).toEqual([]);
    });

    it('an ending that cannot be recorded rolls the session delete back - both or neither', async () => {
      const { service, repo, enqueue, drain } = makeService();
      const sid = await boundSession(service, 'user-1', 'phone-1');
      enqueue.mockRejectedValueOnce(new Error('relation does not exist'));

      await expect(service.revoke(sid)).rejects.toThrow('relation does not exist');

      expect(repo.rows.map((r) => r.id)).toEqual([sid]);
      expect(drain).not.toHaveBeenCalled();
    });

    it('the revocation never waits for chat-delivery: the drain runs after the commit, unawaited', async () => {
      const { service, repo, drain } = makeService();
      drain.mockReturnValue(new Promise(() => undefined));
      const sid = await boundSession(service, 'user-1', 'phone-1');

      await expect(service.revoke(sid)).resolves.toBeUndefined();
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

    it('refuses an identifier chat-delivery-service would refuse to address', async () => {
      // A session naming it would record push endings that a 400 refuses for ever.
      const { service, repo } = makeService();
      const opened = await service.create('user-1');

      for (const bad of ['dev 1', 'dev/1', 'dev+1', 'dev;1']) {
        await expect(service.bindDevice('user-1', opened.sessionId, bad)).resolves.toBe(false);
      }
      await expect(service.bindDevice('user-1', opened.sessionId, 'web-a:b@c.d_1')).resolves.toBe(
        true
      );
      expect(repo.rows[0].deviceId).toBe('web-a:b@c.d_1');
    });

    it('holds the device id contract chat-delivery-service holds', () => {
      const contract = JSON.parse(
        readFileSync(
          join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'device-id.json'),
          'utf8'
        )
      ) as { pattern: string };
      expect(DEVICE_ID_PATTERN.source).toBe(contract.pattern);
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

    it('destroys the other session claiming the same device', async () => {
      // A browser profile holds one cookie and one device id, so a second live session naming
      // that device is unreachable from it: abandoned, or held by somebody else. Before this,
      // such a credential stayed valid for seven idle days.
      const { service, repo } = makeService();
      const first = await service.create('user-1');
      await service.bindDevice('user-1', first.sessionId, 'web-a-b');
      const second = await service.create('user-1');

      await expect(service.bindDevice('user-1', second.sessionId, 'web-a-b')).resolves.toBe(true);
      expect(repo.rows.map((r) => r.id)).toEqual([second.sessionId]);
      expect(repo.rows[0].deviceId).toBe('web-a-b');
    });

    it('purges a stray even when the caller session already names the device', async () => {
      // The conditional write must not short-circuit the purge: a session bound long ago would
      // otherwise never clean up a stray that appeared beside it, and the pair would live on.
      const { service, repo } = makeService();
      const mine = await service.create('user-1');
      await service.bindDevice('user-1', mine.sessionId, 'web-a-b');
      const stray = await service.create('user-1');
      repo.rows[1].deviceId = 'web-a-b';
      const writes = jest.spyOn(repo, 'update');

      await expect(service.bindDevice('user-1', mine.sessionId, 'web-a-b')).resolves.toBe(true);
      expect(repo.rows.map((r) => r.id)).toEqual([mine.sessionId]);
      expect(repo.rows.map((r) => r.id)).not.toContain(stray.sessionId);
      expect(writes).not.toHaveBeenCalled();
    });

    it('leaves another user session alone even when it names the same device string', async () => {
      // Device ids are client-asserted labels, so two accounts CAN carry the same string. The
      // purge is scoped by user; anything wider would let one account sign another one out.
      const { service, repo } = makeService();
      const mine = await service.create('user-1');
      const theirs = await service.create('user-2');
      repo.rows[1].deviceId = 'web-a-b';

      await expect(service.bindDevice('user-1', mine.sessionId, 'web-a-b')).resolves.toBe(true);
      expect(repo.rows.map((r) => r.id)).toEqual([mine.sessionId, theirs.sessionId]);
    });
  });

  describe('the stored IP is bounded by the idle deadline (privacy policy: 90 days at most)', () => {
    const TTL_MS = SESSION_TTL_SECONDS * 1000;

    it('moves the deadline exactly one TTL past the moment a session first records an IP', async () => {
      const { service, repo } = makeService();
      await service.create('user-1', { ip: '10.0.0.1' });

      const row = repo.rows[0];
      expect(row.lastIp).toBe('10.0.0.1');
      expect(row.expiresAt.getTime() - row.lastUsedAt.getTime()).toBe(TTL_MS);
    });

    it('moves the deadline with every rotation that rewrites the IP', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1', { ip: '10.0.0.1' });

      await service.rotate(opened.sessionId, opened.tokenId, { ip: '10.0.0.2' });

      const row = repo.rows[0];
      expect(row.lastIp).toBe('10.0.0.2');
      expect(row.expiresAt.getTime() - row.lastUsedAt.getTime()).toBe(TTL_MS);
    });

    it('never touches the IP or the deadline when a device is bound', async () => {
      const { service, repo } = makeService();
      const opened = await service.create('user-1', { ip: '10.0.0.1' });
      const before = { ip: repo.rows[0].lastIp, expiresAt: repo.rows[0].expiresAt.getTime() };

      await service.bindDevice('user-1', opened.sessionId, 'device-a');

      expect(repo.rows[0].lastIp).toBe(before.ip);
      expect(repo.rows[0].expiresAt.getTime()).toBe(before.expiresAt);
    });

    it('keeps a stored IP far inside the 90 days the privacy policy promises', () => {
      const promiseMs = 90 * 24 * 60 * 60 * 1000;
      expect(TTL_MS + SWEEP_INTERVAL_MS).toBeLessThan(promiseMs);
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
