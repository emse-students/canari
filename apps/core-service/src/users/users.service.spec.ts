import { Logger } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { InvalidUserIdError } from './user-id';
import { UsersService } from './users.service';
import type { UserBlocksService } from './user-blocks.service';
import { User } from './entities/user.entity';
import { UserRowGoneError } from './user-write';
import {
  HELD_NOTEPAD_SQL,
  NotepadChangedException,
  NotepadMovedException,
  heldNotepad,
  notepadDigest,
} from './notepad';
import { REVIEW_COHORT_BOUNDARY, ReviewCohortBoundaryException } from '../review-cohort';

/**
 * Blocking is exercised by `user-blocks.service.spec.ts`; here it only has to be present. An
 * account's blocks are erased with it by `AccountErasureService` (`CORE_ERASURE_STATEMENTS`).
 */
function makeBlocksStub() {
  return {
    invisibleUserIdsFor: jest.fn().mockResolvedValue([]),
  } as unknown as UserBlocksService;
}

/**
 * Focused tests for the parameter-tampering guard in `UsersService.search`.
 * Express query parsing can hand a `string[]` or object where a `string` is
 * declared; the guard must reject those before any string operation reaches the
 * fuzzy SQL matcher.
 */
describe('UsersService.search type guard', () => {
  function makeService() {
    const createQueryBuilder = jest.fn();
    const userRepository = {
      createQueryBuilder,
    } as unknown as Repository<User>;
    const dataSource = {} as DataSource;
    const service = new UsersService(userRepository, dataSource, makeBlocksStub());
    return { service, createQueryBuilder };
  }

  it('returns [] and never builds a query for an array-valued param', async () => {
    const { service, createQueryBuilder } = makeService();
    const result = await service.search(['a', 'b'] as unknown as string);
    expect(result).toEqual([]);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns [] and never builds a query for an object-valued param', async () => {
    const { service, createQueryBuilder } = makeService();
    const result = await service.search({ x: 1 } as unknown as string);
    expect(result).toEqual([]);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns [] for an empty string without building a query', async () => {
    const { service, createQueryBuilder } = makeService();
    const result = await service.search('');
    expect(result).toEqual([]);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});

/**
 * The notepad is stored as opaque ciphertext under a per-user key, and is RETIRED into "Mes notes"
 * (`notepad.ts`). These cover what would silently defeat either: leaking the legacy plaintext once
 * an encrypted copy exists, regenerating the key on every read, writing or minting for a notepad
 * that has moved, and deleting a notepad other than the one the mover read.
 */
describe('UsersService notepad', () => {
  /**
   * One stored row. `query` plays the three statements the service writes in PostgreSQL's
   * `[rows, count]` shape - the key's `COALESCE`, the conditional save and the conditional move -
   * against that row, with `HELD_NOTEPAD_SQL`'s rule (ciphertext, else legacy plaintext, '' = none).
   */
  function makeService(user: Partial<User>) {
    const stored = { id: 'u1', ...user } as User;
    let gone = false;
    const save = jest.fn();
    const held = () => (gone ? '' : heldNotepad(stored));
    const query = jest.fn(async (sql: string, params: string[]) => {
      if (gone) return [[], 0];
      if (sql.includes('COALESCE("notesKey"')) {
        stored.notesKey = stored.notesKey ?? params[1];
        return [[{ notesKey: stored.notesKey }], 1];
      }
      if (sql.includes('SET "notesCiphertext" = $2')) {
        if (!held()) return [[], 0];
        stored.notesCiphertext = params[1];
        stored.notes = null;
        return [[{ id: 'u1' }], 1];
      }
      if (sql.includes('"notesKey" = NULL')) {
        if (held() !== params[1]) return [[], 0];
        stored.notes = null;
        stored.notesCiphertext = null;
        stored.notesKey = null;
        return [[{ id: 'u1' }], 1];
      }
      throw new Error(`unexpected statement: ${sql}`);
    });
    const findOne = jest.fn(async () => (gone ? null : { ...stored }));
    const userRepository = { findOne, save, query } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, makeBlocksStub());
    return { service, stored, save, query, findOne, erase: () => (gone = true) };
  }

  it('returns the ciphertext and hides the legacy plaintext once one exists', async () => {
    const { service } = makeService({ notesCiphertext: 'AAAA', notes: 'my bank pin' });
    await expect(service.getNotes('u1')).resolves.toEqual({
      ciphertext: 'AAAA',
      legacyNotes: '',
    });
  });

  it('hands back the legacy plaintext only while nothing encrypted exists', async () => {
    const { service } = makeService({ notes: 'written before encryption' });
    await expect(service.getNotes('u1')).resolves.toEqual({
      ciphertext: '',
      legacyNotes: 'written before encryption',
    });
  });

  it('answers NOTEPAD_MOVED to a read when no notepad is held', async () => {
    const { service } = makeService({ notesCiphertext: '', notes: null });
    await expect(service.getNotes('u1')).rejects.toBeInstanceOf(NotepadMovedException);
    await expect(service.getNotes('u1')).rejects.toMatchObject({
      response: { code: 'NOTEPAD_MOVED' },
      status: 410,
    });
  });

  it('drops the plaintext when a ciphertext is saved over a held notepad', async () => {
    const { service, stored, query, save } = makeService({ notes: 'my bank pin', admin: false });
    await service.setNotes('u1', 'BBBB');
    expect(stored.notesCiphertext).toBe('BBBB');
    expect(stored.notes).toBeNull();
    // ONE statement, conditioned on a notepad still held, naming the two notepad columns only.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(`AND ${HELD_NOTEPAD_SQL} IS NOT NULL`);
    expect(save).not.toHaveBeenCalled();
  });

  it('creates no notepad: a save with none held is NOTEPAD_MOVED and writes nothing', async () => {
    const { service, stored } = makeService({});
    await expect(service.setNotes('u1', 'BBBB')).rejects.toBeInstanceOf(NotepadMovedException);
    expect(stored.notesCiphertext).toBeUndefined();
  });

  it('refuses a notepad write to a row that is gone, and writes nothing', async () => {
    const { service, erase, findOne, save } = makeService({ notesCiphertext: 'AAAA' });
    // Read before the erasure, written after it.
    findOne.mockImplementationOnce(async () => ({ id: 'u1', notesCiphertext: 'AAAA' }) as User);
    erase();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(service.setNotes('u1', 'BBBB')).rejects.toBeInstanceOf(UserRowGoneError);
    expect(save).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('generates a 32-byte hex key once for a held notepad, then returns the same one', async () => {
    const { service, query, save } = makeService({ notes: 'legacy' });
    const key = await service.getOrCreateNotesKey('u1');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('COALESCE("notesKey"');

    // A second read must not rotate the key: every stored note would be lost.
    await expect(service.getOrCreateNotesKey('u1')).resolves.toBe(key);
    expect(query).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('serves and mints no key when no notepad is held', async () => {
    const { service, query } = makeService({ notesKey: 'k'.repeat(64) });
    await expect(service.getOrCreateNotesKey('u1')).rejects.toBeInstanceOf(NotepadMovedException);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers the key another first call stored, not the one it minted', async () => {
    const { service, stored, findOne } = makeService({ notes: 'legacy' });
    // This call read the row before the other call's key landed.
    findOne.mockImplementationOnce(async () => {
      const answer = { ...stored };
      stored.notesKey = 'k'.repeat(64);
      return answer;
    });
    await expect(service.getOrCreateNotesKey('u1')).resolves.toBe('k'.repeat(64));
    expect(stored.notesKey).toBe('k'.repeat(64));
  });

  it('mints no key for a row that is gone', async () => {
    const { service, erase, findOne } = makeService({ notes: 'legacy' });
    findOne.mockImplementationOnce(async () => ({ id: 'u1', notes: 'legacy' }) as User);
    erase();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(service.getOrCreateNotesKey('u1')).rejects.toBeInstanceOf(UserRowGoneError);
    warn.mockRestore();
  });

  describe('the move into "Mes notes"', () => {
    it('deletes the notepad, its legacy plaintext and its key when the digest names it', async () => {
      const { service, stored } = makeService({ notesCiphertext: 'AAAA', notesKey: 'k' });
      await service.moveNotes('u1', notepadDigest('AAAA'));
      expect(stored.notesCiphertext).toBeNull();
      expect(stored.notes).toBeNull();
      expect(stored.notesKey).toBeNull();
      // Every route has retired for this account now.
      await expect(service.getNotes('u1')).rejects.toBeInstanceOf(NotepadMovedException);
    });

    it('moves a legacy plaintext notepad by the digest of the plaintext served', async () => {
      const { service, stored } = makeService({ notes: 'written before encryption' });
      await service.moveNotes('u1', notepadDigest('written before encryption'));
      expect(stored.notes).toBeNull();
    });

    it('deletes nothing when the digest names another notepad (saved since its read)', async () => {
      const { service, stored, query } = makeService({ notesCiphertext: 'NEWER' });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await expect(service.moveNotes('u1', notepadDigest('OLDER'))).rejects.toMatchObject({
        response: { code: 'NOTEPAD_CHANGED' },
        status: 409,
      });
      expect(stored.notesCiphertext).toBe('NEWER');
      expect(query).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('deletes nothing when a save lands between the read and the conditional delete', async () => {
      const { service, stored, findOne } = makeService({ notesCiphertext: 'AAAA' });
      // The mover's read sees AAAA; an older build's save lands before its statement runs.
      findOne.mockImplementationOnce(async () => {
        const answer = { ...stored };
        stored.notesCiphertext = 'SAVED';
        return answer;
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await expect(service.moveNotes('u1', notepadDigest('AAAA'))).rejects.toBeInstanceOf(
        NotepadChangedException
      );
      expect(stored.notesCiphertext).toBe('SAVED');
      warn.mockRestore();
    });

    it('answers NOTEPAD_MOVED to a second mover: another device moved it first', async () => {
      const { service } = makeService({ notesCiphertext: 'AAAA' });
      await service.moveNotes('u1', notepadDigest('AAAA'));
      await expect(service.moveNotes('u1', notepadDigest('AAAA'))).rejects.toBeInstanceOf(
        NotepadMovedException
      );
    });
  });
});

/** The admin flag is ONE column update: nothing read, nothing else written. */
describe('UsersService.setAdmin', () => {
  it('updates the flag alone, keyed by the id, and answers 404 for a row that is gone', async () => {
    const update = jest
      .fn()
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });
    const findOne = jest.fn();
    const save = jest.fn();
    const userRepository = { update, findOne, save } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, makeBlocksStub());
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.setAdmin('u1', false);
    expect(update).toHaveBeenCalledWith({ id: 'u1' }, { admin: false });
    await expect(service.setAdmin('u2', true)).rejects.toBeInstanceOf(UserRowGoneError);
    expect(findOne).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** A profile write names the fields it was given, and answers the row as it now stands. */
describe('UsersService.update', () => {
  it('writes only the given fields, never a save of the row read', async () => {
    const stored = { id: 'u1', bio: 'old', admin: false } as User;
    const update = jest.fn(async (_w: unknown, patch: Partial<User>) => {
      Object.assign(stored, patch);
      return { affected: 1 };
    });
    const save = jest.fn();
    const userRepository = {
      update,
      save,
      findOne: jest.fn(async () => ({ ...stored })),
    } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, makeBlocksStub());
    await expect(service.update('u1', { bio: 'new' })).resolves.toMatchObject({ bio: 'new' });
    expect(update).toHaveBeenCalledWith({ id: 'u1' }, { bio: 'new' });
    expect(save).not.toHaveBeenCalled();
  });

  it('answers 404 for a row that is gone, and writes nothing', async () => {
    const save = jest.fn();
    const userRepository = {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      save,
      findOne: jest.fn(),
    } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, makeBlocksStub());
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(service.update('u1', { bio: 'new' })).rejects.toBeInstanceOf(UserRowGoneError);
    expect(save).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The MiConnect profile is REPLACED at every sign-in (WP3): a claim that vanished at authentik must
 * clear the column, and `promo`/`formation` follow the first cursus entry.
 */
describe('UsersService.create - the administrator mint point', () => {
  it.each(['Élise', 'alice:dev', ''])('refuses an id that is not mintable (%j)', async (id) => {
    const save = jest.fn();
    const userRepository = {
      create: jest.fn().mockImplementation((u: Partial<User>) => u),
      save,
    } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, makeBlocksStub());
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(service.create({ id } as never)).rejects.toBeInstanceOf(InvalidUserIdError);
    expect(save).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('UsersService.findOrCreateFromOidc profile', () => {
  const profile = {
    miconnectUuid: 'uuid-1',
    campus: 'gardanne' as const,
    cursus: [{ formation: 'ISMIN', promo: 2025 }],
    posts: ['ALUMNI' as const],
    alumniLinked: null,
    mailClass: null,
  };

  function makeService(existing: Partial<User> | null, affected = 1) {
    const save = jest.fn().mockImplementation(async (u: User) => u);
    const update = jest.fn().mockResolvedValue({ affected });
    const userRepository = {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation((u: Partial<User>) => u),
      save,
      update,
    } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, makeBlocksStub());
    return { service, save, update };
  }

  it('accuses a sign-in that takes away the campus or the whole cursus (no space left)', async () => {
    const stored = { id: 's1', displayName: 'A B', ...profile, promo: 2025, formation: 'ISMIN' };
    const { service } = makeService(stored);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', {
        miconnectUuid: 'uuid-1',
        campus: null,
        cursus: [],
        posts: [],
        alumniLinked: null,
        mailClass: null,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[OIDC_PROFILE_SHRANK]'));
      warn.mockClear();
      // A change that keeps a campus and a cursus is not one.
      const { service: other } = makeService(stored);
      await other.findOrCreateFromOidc('s1', 'A B', 'A', 'B', {
        ...profile,
        campus: 'saint-etienne',
      });
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('[OIDC_PROFILE_SHRANK]'));
    } finally {
      warn.mockRestore();
    }
  });

  it('creates an account carrying the profile and the derived promo/formation', async () => {
    const { service, save } = makeService(null);
    await service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', profile);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ ...profile, promo: 2025, formation: 'ISMIN' })
    );
  });

  it('replaces the stored profile, and clears what the provider stopped sending', async () => {
    const stored = {
      id: 's1',
      displayName: 'A B',
      firstName: 'A',
      lastName: 'B',
      ...profile,
      promo: 2025,
      formation: 'ISMIN',
    };
    const { service, save, update } = makeService(stored);
    const user = await service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', {
      miconnectUuid: 'uuid-1',
      campus: 'saint-etienne',
      cursus: [],
      posts: ['EMSE'],
      alumniLinked: false,
      mailClass: null,
    });
    // The changed claims as one column update; the row read is never saved back.
    expect(save).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ id: 's1' }, expect.not.objectContaining({ admin: true }));
    expect(Object.keys(update.mock.calls[0][1]).sort()).toEqual(
      [
        'alumniLinked',
        'campus',
        'cursus',
        'formation',
        'mailClass',
        'miconnectUuid',
        'posts',
        'promo',
      ].sort()
    );
    expect(user).toMatchObject({
      campus: 'saint-etienne',
      cursus: [],
      posts: ['EMSE'],
      promo: null,
      formation: null,
    });
  });

  it('refreshes the mail class at each sign-in, the class and never an address', async () => {
    const stored = { id: 's1', displayName: 'A B', ...profile, promo: 2025, formation: 'ISMIN' };
    const { service, update } = makeService(stored);
    await service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', { ...profile, mailClass: 'student' });
    expect(update).toHaveBeenCalledWith(
      { id: 's1' },
      expect.objectContaining({ mailClass: 'student' })
    );
    // And a claim that vanished takes the class away: not offered, never a stale "student".
    const back = makeService({ ...stored, mailClass: 'student' });
    await back.service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', profile);
    expect(back.update).toHaveBeenCalledWith(
      { id: 's1' },
      expect.objectContaining({ mailClass: null })
    );
  });

  it('leaves the stored class alone when the sign-in carried none (scope not granted)', async () => {
    const stored = {
      id: 's1',
      displayName: 'A B',
      firstName: 'A',
      lastName: 'B',
      ...profile,
      mailClass: 'student' as const,
      promo: 2025,
      formation: 'ISMIN',
    };
    const { mailClass: _granted, ...ungranted } = profile;
    const { service, update } = makeService(stored);
    const user = await service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', ungranted);
    expect(update).not.toHaveBeenCalled();
    expect(user.mailClass).toBe('student');
    // And a change elsewhere does not carry the class with it.
    const other = makeService(stored);
    await other.service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', {
      ...ungranted,
      campus: 'saint-etienne',
    });
    expect(other.update.mock.calls[0][1]).not.toHaveProperty('mailClass');
  });

  it('returns the STORED class when the update is refused, and the other claims as before', async () => {
    const stored = { id: 's1', displayName: 'A B', ...profile, promo: 2025, formation: 'ISMIN' };
    const { service, update } = makeService(stored);
    update.mockRejectedValueOnce(new Error('database refused'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const user = await service.findOrCreateFromOidc('s1', 'A B 2', 'A', 'B', {
      ...profile,
      campus: 'saint-etienne',
      mailClass: 'student',
    });
    // The class is the one thing the answer must not claim unwritten (the relay reads the column).
    expect(user.mailClass).toBeNull();
    // Every other claim joins the answer whatever the write did, exactly as before the mail class.
    expect(user).toMatchObject({ campus: 'saint-etienne', displayName: 'A B 2' });
    warn.mockRestore();
  });

  it('does not write when nothing changed', async () => {
    const stored = {
      id: 's1',
      displayName: 'A B',
      firstName: 'A',
      lastName: 'B',
      ...profile,
      promo: 2025,
      formation: 'ISMIN',
    };
    const { service, save, update } = makeService(stored);
    await service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', profile);
    expect(save).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not write when jsonb handed the cursus keys back in its own order', async () => {
    const stored = {
      id: 's1',
      displayName: 'A B',
      firstName: 'A',
      lastName: 'B',
      ...profile,
      // jsonb orders keys shorter first: promo before formation.
      cursus: [{ promo: 2025, formation: 'ISMIN' }],
      promo: 2025,
      formation: 'ISMIN',
    };
    const { service, update } = makeService(stored);
    await service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', profile);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses, typed, a row read and gone before its update - and re-creates nothing', async () => {
    const stored = { id: 's1', displayName: 'Old', ...profile, promo: 2025, formation: 'ISMIN' };
    const { service, save } = makeService(stored, 0);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(
      service.findOrCreateFromOidc('s1', 'A B', 'A', 'B', profile)
    ).rejects.toBeInstanceOf(UserRowGoneError);
    expect(save).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** The directory's campus and post filters (WP3) must reach the query, and count as a filter. */
describe('UsersService.directory campus and post filters', () => {
  function makeService(hidden: string[] = []) {
    const where: Array<[string, unknown]> = [];
    const orders: string[] = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'select',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
      'andWhere',
      'where',
      'leftJoin',
    ]) {
      qb[m] = jest.fn().mockImplementation((sql?: string, params?: unknown) => {
        if (m === 'andWhere') where.push([sql as string, params]);
        if (m === 'orderBy' || m === 'addOrderBy') orders.push(`${m}:${sql}`);
        return qb;
      });
    }
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getMany = jest.fn().mockResolvedValue([]);
    const invisibleUserIdsFor = jest.fn().mockResolvedValue(hidden);
    const blocks = { invisibleUserIdsFor } as unknown as UserBlocksService;
    const userRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, blocks);
    return { service, where, orders, invisibleUserIdsFor };
  }

  it('accepts a campus alone as a filter and applies it', async () => {
    const { service, where } = makeService();
    await service.directory({ campus: 'gardanne' });
    expect(where).toContainEqual(['user.campus = :campus', { campus: 'gardanne' }]);
  });

  it('accepts a post alone as a filter and matches it against the array', async () => {
    const { service, where } = makeService();
    await service.directory({ post: 'ALUMNI' });
    expect(where).toContainEqual([':post = ANY(user.posts)', { post: 'ALUMNI' }]);
  });

  // D32: the promo and formation filters read every cursus entry OR the legacy pair, the two from the
  // same place. Judged on SQL in `cursus-reads.integration.spec.ts`; here, that the query asks it.
  it('filters promo and formation through one cursus entry or the legacy pair', async () => {
    const { service, where } = makeService();
    await service.directory({ promo: 2024, formation: 'ICM' });
    const filter = where.find(([sql]) => sql.includes('jsonb_array_elements'));
    expect(filter?.[0]).toContain("entry->>'promo' = :cursusPromoText");
    expect(filter?.[0]).toContain(
      'OR (user.promo = :legacyPromo AND unaccent(LOWER(user.formation)) LIKE'
    );
    expect(filter?.[0]).toContain("jsonb_typeof(user.cursus) = 'array'");
    expect(filter?.[1]).toEqual({
      cursusPromoText: '2024',
      legacyPromo: 2024,
      cursusFormation: '%ICM%',
    });
  });

  it('hides accounts blocked in either direction, as the New chat search does', async () => {
    const { service, where, invisibleUserIdsFor } = makeService(['blocked-1', 'blocker-2']);
    await service.directory({ campus: 'gardanne' }, 'me');
    expect(invisibleUserIdsFor).toHaveBeenCalledWith('me');
    expect(where).toContainEqual([
      'user.id NOT IN (:...blockedIds)',
      { blockedIds: ['blocked-1', 'blocker-2'] },
    ]);
  });

  it('adds no block clause when the reader has no block either way', async () => {
    const { service, where, invisibleUserIdsFor } = makeService([]);
    await service.directory({ campus: 'gardanne' }, 'me');
    expect(invisibleUserIdsFor).toHaveBeenCalledWith('me');
    expect(where.some(([sql]) => sql.includes('blockedIds'))).toBe(false);
  });

  // D56: the clause itself is judged against PostgreSQL in picker-merging-duplicate.integration.spec.ts.
  it('leaves out a duplicate whose Alumni merge is open, beside the block clause', async () => {
    const { service, where } = makeService(['blocked-1']);
    await service.directory({ campus: 'gardanne' }, 'me');
    const merging = where.find(([sql]) => sql.includes('alumni_merges'));
    expect(merging?.[0]).toContain('NOT EXISTS');
    expect(merging?.[0]).toContain('merging."duplicateUuid" = user.miconnectUuid');
    expect(merging?.[0]).toContain('merging."completedAt" IS NULL');
    expect(where.some(([sql]) => sql.includes('blockedIds'))).toBe(true);
  });

  it('breaks ties on the id after the name order, so offset paging is stable', async () => {
    const { service, orders } = makeService();
    await service.directory({ campus: 'gardanne' });
    expect(orders).toEqual(['orderBy:user.displayName', 'addOrderBy:user.id']);
  });
});

/**
 * The review cohort (`review-cohort.ts`) in the directory and the search: a review account finds
 * the cohort only, a member never finds a review account, an admin finds everybody.
 */
describe('UsersService review cohort', () => {
  const COHORT = 'aa01,bb02';
  const saved = process.env.SERVICE_ACCOUNT_USER_ID;
  beforeEach(() => {
    process.env.SERVICE_ACCOUNT_USER_ID = COHORT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
    else process.env.SERVICE_ACCOUNT_USER_ID = saved;
  });

  function makeService(requesterIsAdmin: boolean) {
    const where: Array<[string, unknown]> = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'select',
      'addSelect',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
      'andWhere',
      'where',
      'setParameters',
      'setParameter',
    ]) {
      qb[m] = jest.fn().mockImplementation((sql?: string, params?: unknown) => {
        if (m === 'andWhere') where.push([sql as string, params]);
        return qb;
      });
    }
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getMany = jest.fn().mockResolvedValue([]);
    qb.getRawOne = jest.fn().mockResolvedValue({ admin: requesterIsAdmin });
    const userRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource, makeBlocksStub());
    return { service, where, qb };
  }

  it('shows a review account the cohort and nobody else, admins included', async () => {
    const { service, where } = makeService(false);
    await service.directory({ campus: 'saint-etienne' }, 'bb02');
    expect(where).toContainEqual([
      'user.id IN (:...reviewCohort)',
      { reviewCohort: ['aa01', 'bb02'] },
    ]);
    expect(where.some(([sql]) => sql.includes('user.admin'))).toBe(false);
  });

  it('never shows a member a review account, in the search either', async () => {
    const { service, where } = makeService(false);
    await service.search('Camille', 'cc03');
    expect(where).toContainEqual([
      'user.id NOT IN (:...reviewCohort)',
      { reviewCohort: ['aa01', 'bb02'] },
    ]);
  });

  it('hides a duplicate waiting for its merge from the search too, and answers the earliest cursus (D56)', async () => {
    const { service, where, qb } = makeService(false);
    qb.getMany.mockResolvedValue([
      {
        id: 'u1',
        displayName: 'Camille Durand',
        cursus: [
          { formation: 'ISMIN', promo: 2022 },
          { formation: 'ICM', promo: 2019 },
        ],
        promo: 2022,
        formation: 'ISMIN',
      },
      { id: 'u2', displayName: 'Camille Durand', cursus: [], promo: 2020, formation: null },
    ]);
    expect(await service.search('Camille', 'cc03')).toEqual([
      { id: 'u1', displayName: 'Camille Durand', promo: 2019, formation: 'ICM' },
      { id: 'u2', displayName: 'Camille Durand', promo: 2020, formation: null },
    ]);
    expect(where.some(([sql]) => sql.includes('NOT EXISTS (SELECT 1 FROM alumni_merges'))).toBe(
      true
    );
  });

  it('shows a global admin everybody, so the team can reach the review accounts', async () => {
    const { service, where } = makeService(true);
    await service.directory({ campus: 'saint-etienne' }, 'dd04');
    expect(where.some(([sql]) => sql.includes('reviewCohort'))).toBe(false);
  });

  it('opens a profile on the same side, and refuses one across, both ways (403, typed)', async () => {
    const member = makeService(false).service;
    await expect(member.assertMayOpenProfile('aa01', 'bb02')).resolves.toBeUndefined();
    await expect(member.assertMayOpenProfile('cc03', 'dd04')).resolves.toBeUndefined();
    for (const [from, to] of [
      ['aa01', 'cc03'],
      ['cc03', 'aa01'],
    ]) {
      const refusal = await member.assertMayOpenProfile(from, to).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ReviewCohortBoundaryException);
      expect((refusal as ReviewCohortBoundaryException).getResponse()).toEqual(
        expect.objectContaining({ code: REVIEW_COHORT_BOUNDARY })
      );
    }
  });

  it('lets a global admin open a review account, and never lets a review account open an admin', async () => {
    const asAdmin = makeService(true).service;
    await expect(asAdmin.assertMayOpenProfile('ad01', 'aa01')).resolves.toBeUndefined();
    await expect(asAdmin.assertMayOpenProfile('aa01', 'ad01')).rejects.toBeInstanceOf(
      ReviewCohortBoundaryException
    );
  });

  it('answers a batch with the ids on the same side only, both ways', async () => {
    const { service } = makeService(false);
    expect(await service.profilesOpenTo('aa01', ['bb02', 'cc03'])).toEqual(['bb02']);
    expect(await service.profilesOpenTo('cc03', ['bb02', 'dd04'])).toEqual(['dd04']);
  });

  it('restricts nothing with no cohort configured', async () => {
    delete process.env.SERVICE_ACCOUNT_USER_ID;
    const { service, where } = makeService(false);
    await service.directory({ campus: 'saint-etienne' }, 'aa01');
    expect(where.some(([sql]) => sql.includes('reviewCohort'))).toBe(false);
  });
});
