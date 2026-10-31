/**
 * A USER WRITE UPDATES ITS COLUMNS AND NEVER SAVES THE ROW IT READ, AGAINST A REAL POSTGRESQL.
 *
 * Every path that writes an existing user row writes the COLUMNS it owns, keyed by the id, and treats
 * 0 rows updated as "the row is gone". A TypeORM `save` of an entity read earlier is not that: it
 * writes back every column a concurrent writer changed since the read, and inserts the row again
 * when it was deleted meanwhile. Each case lets a concurrent writer commit between the service's
 * read and its write - the writer runs from inside the service's own repository call, so the
 * interleaving is deterministic (never a sleep) - and asserts what the row holds afterwards.
 *
 * And the admin flag's removal, end to end: the person's sessions end with it, so an access token
 * minted while they held the flag authenticates nothing at `/api/auth/verify` afterwards.
 *
 * GATED ON `CORE_IT_DATABASE_URL`, like the other integration files; the `boot-nest-apps` job in
 * `ci.yml` sets it. It needs no existing schema: the tables are created from their entities in a
 * throwaway schema, dropped at the end.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- user-write-gone.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { DataSource, Repository } from 'typeorm';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { DeviceRevokedSession } from '../auth/entities/device-revoked-session.entity';
import { AuthSessionsService } from '../auth/auth-sessions.service';
import { SessionPushEndService } from '../auth/session-push-end.service';
import { AuthController } from '../auth/auth.controller';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { ProfileChange } from './entities/profile-change.entity';
import { ProfileCorrectionRequest } from './entities/profile-correction-request.entity';
import { UsersService } from './users.service';
import { ProfileEditService } from './profile-edit.service';
import type { MiconnectEditorClient } from './miconnect-editor.client';
import type { UserBlocksService } from './user-blocks.service';
import { UserRowGoneError } from './user-write';

jest.mock('axios');

const URL = process.env.CORE_IT_DATABASE_URL;
const JWT_SECRET = 'user-write-it-secret';
/** `session_push_endings`, as production gets it: every session end records into it. */
const PUSH_ENDINGS_MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '016_session_push_endings.sql'),
  'utf8'
);
const maybe = URL ? describe : describe.skip;

const PROFILE = {
  miconnectUuid: '11111111-2222-3333-4444-555555555555',
  campus: 'gardanne' as const,
  cursus: [{ formation: 'ISMIN' as const, promo: 2024 }],
  posts: ['ME' as const],
};
const EDIT = { ...PROFILE, firstName: 'Camille', lastName: 'Durand' };

/** The repository calls a service makes on the user rows: a read, or one of three writes. */
const READS = ['findOne'] as const;
const WRITES = ['update', 'save', 'query'] as const;

maybe('a user write against PostgreSQL', () => {
  const schema = `user_write_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let users: Repository<User>;
  let service: UsersService;
  let profiles: ProfileEditService;
  let sessions: AuthSessionsService;
  let usersRoute: UsersController;
  let auth: AuthController;
  let seq = 0;
  const env = { ...process.env };

  /** The headers `/api/auth/verify` hands nginx for this bearer token. */
  const verify = async (token: string): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    const res = {
      set: (k: string, v: string) => (headers[k] = v),
      status: () => ({ send: () => undefined, json: () => undefined }),
    } as unknown as Response;
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    await auth.verify(req, res);
    return headers;
  };

  /** A fresh account per case: an admin with a name, a profile and no notepad key. */
  const seed = async (): Promise<string> => {
    const id = `it-user-${++seq}`;
    await users.insert({ id, displayName: 'Old Name', admin: true, ...PROFILE, promo: 2024 });
    return id;
  };
  const rowOf = (id: string) => users.findOne({ where: { id } });
  /** What an account erasure does to the row: `DELETE FROM users` (`CORE_ERASURE_STATEMENTS`). */
  const erase = (id: string) => ds.query(`DELETE FROM users WHERE id = $1`, [id]);
  /** The admin revoke, as the admin route makes it. */
  const revoke = (id: string) => service.setAdmin(id, false);

  /**
   * Runs `hook` once, at the first moment a concurrent writer can land between the service's read
   * and its write: right after its next read of a user row has answered, or right before its next
   * write when it reads nothing first. Every spy is gone before `hook` runs, so the hook's own calls
   * are real. Answers whether it ran, so a case proves its interleaving happened.
   */
  const interleave = (hook: () => Promise<unknown>): (() => boolean) => {
    let ran = false;
    const spies: jest.SpyInstance[] = [];
    const fire = async () => {
      for (const s of spies) s.mockRestore();
      ran = true;
      await hook();
    };
    const target = users as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const m of READS) {
      const original = target[m].bind(users);
      spies.push(
        jest.spyOn(users, m).mockImplementation((async (...args: unknown[]) => {
          const answer = await original(...args);
          await fire();
          return answer;
        }) as never)
      );
    }
    for (const m of WRITES) {
      const original = target[m].bind(users);
      spies.push(
        jest.spyOn(users, m).mockImplementation((async (...args: unknown[]) => {
          await fire();
          return original(...args);
        }) as never)
      );
    }
    return () => ran;
  };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [User, ProfileChange, ProfileCorrectionRequest, AuthSession, DeviceRevokedSession],
      synchronize: true,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    users = ds.getRepository(User);
    const blocks = { invisibleUserIdsFor: async () => [] } as unknown as UserBlocksService;
    service = new UsersService(users, ds, blocks);
    // authentik answers and accepts every write: only Canari's row is under test here.
    const editor = {
      assertAvailable: () => undefined,
      findUserByUuid: async () => ({ pk: 1, attributes: {} }),
      writeUser: async () => undefined,
    } as unknown as MiconnectEditorClient;
    profiles = new ProfileEditService(users, ds, editor);

    await ds.query(PUSH_ENDINGS_MIGRATION);
    const axios = jest.requireMock('axios') as { delete: jest.Mock };
    axios.delete = jest.fn().mockResolvedValue({ data: { removed: 0 } });
    sessions = new AuthSessionsService(
      ds.getRepository(AuthSession),
      new SessionPushEndService(ds),
      ds.getRepository(DeviceRevokedSession)
    );
    const erasure = { erasureState: async () => 'none' };
    const unused = {} as never;
    usersRoute = new UsersController(
      service,
      unused,
      unused,
      profiles,
      unused,
      erasure as never,
      sessions
    );
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_INSECURE_COOKIES = 'false';
    const platform = { getConfig: async () => ({}), isAccessBlockedByMaintenance: () => false };
    auth = new AuthController(
      service,
      platform as never,
      sessions,
      { enabled: false } as never,
      erasure as never,
      unused
    );
  }, 60_000);

  afterAll(async () => {
    process.env = { ...env };
    jest.restoreAllMocks();
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  }, 60_000);

  /** Each user write, run against a row a concurrent writer changes or deletes under it. */
  const WRITERS: Array<[string, (id: string) => Promise<unknown>]> = [
    ['a notepad save', (id) => service.setNotes(id, 'CIPHERTEXT')],
    ['a first notepad key', (id) => service.getOrCreateNotesKey(id)],
    ['a profile write', (id) => service.update(id, { bio: 'hello' })],
    [
      'a sign-in refreshing its claims',
      (id) => service.findOrCreateFromOidc(id, 'New Name', null, null, PROFILE),
    ],
    ['an admin profile edit', (id) => profiles.applyEdit(id, 'it-admin', EDIT)],
    ['an admin flag write', (id) => service.setAdmin(id, true)],
  ];

  // The admin flag write is the revoke's own column, so the revoke case is meaningless for it.
  it.each(WRITERS.filter(([name]) => name !== 'an admin flag write'))(
    '%s across a revoke leaves the flag revoked',
    async (_name, write) => {
      const id = await seed();
      const ran = interleave(() => revoke(id));
      await write(id);
      expect(ran()).toBe(true);
      expect((await rowOf(id))?.admin).toBe(false);
    }
  );

  it.each(WRITERS)('%s across an erasure is refused and leaves no row', async (_name, write) => {
    const id = await seed();
    const ran = interleave(() => erase(id));
    const outcome = await write(id).then(
      () => 'written',
      (e: unknown) => e
    );
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(UserRowGoneError);
    expect(await rowOf(id)).toBeNull();
    expect(await ds.getRepository(ProfileChange).count({ where: { userId: id } })).toBe(0);
  });

  it('two first notepad key calls answer the same key, and it is the stored one', async () => {
    const id = await seed();
    let inner: string | undefined;
    const ran = interleave(async () => {
      inner = await service.getOrCreateNotesKey(id);
    });
    const outer = await service.getOrCreateNotesKey(id);
    expect(ran()).toBe(true);
    expect(inner).toMatch(/^[0-9a-f]{64}$/);
    expect(outer).toBe(inner);
    expect((await rowOf(id))?.notesKey).toBe(inner);
  });

  it("removing the flag ends the person's sessions: a token minted before authenticates nothing", async () => {
    const id = await seed();
    const opened = await sessions.create(id);
    const token = jwt.sign(
      { sub: id, admin: true, type: 'access', sid: opened.sessionId },
      JWT_SECRET,
      {
        expiresIn: '1h',
      }
    );
    expect(await verify(token)).toMatchObject({ 'X-Logged-In': 'true', 'X-Global-Admin': 'true' });

    await usersRoute.setAdmin(id, 'it-other-admin', { admin: false });

    expect((await rowOf(id))?.admin).toBe(false);
    expect(await verify(token)).toMatchObject({
      'X-Logged-In': 'false',
      'X-Global-Admin': 'false',
    });
    expect(await ds.getRepository(AuthSession).count({ where: { userId: id } })).toBe(0);
  });

  it('creating a user under an id that has a row is a conflict, and the row is left alone', async () => {
    const id = await seed();
    const outcome = await usersRoute.create({ id, displayName: 'Intruder' }).then(
      () => 'created',
      (e: unknown) => e
    );
    expect(outcome).toBeInstanceOf(ConflictException);
    expect(await rowOf(id)).toMatchObject({ displayName: 'Old Name', admin: true });
  });

  it('a write with nobody racing it still writes its columns', async () => {
    const id = await seed();
    await service.setNotes(id, 'CIPHERTEXT');
    await service.update(id, { bio: 'hello' });
    await service.setAdmin(id, false);
    await service.findOrCreateFromOidc(id, 'New Name', null, null, PROFILE);
    expect(await rowOf(id)).toMatchObject({
      notesCiphertext: 'CIPHERTEXT',
      notes: null,
      bio: 'hello',
      admin: false,
      displayName: 'New Name',
    });
  });
});
