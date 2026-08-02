import type { DataSource, Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';

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
    const service = new UsersService(userRepository, dataSource);
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
 * The notepad is stored as opaque ciphertext under a per-user key. These cover
 * the two things that would silently defeat that: leaking the legacy plaintext
 * once an encrypted copy exists, and regenerating the key on every read.
 */
describe('UsersService notepad', () => {
  function makeService(user: Partial<User>) {
    const stored = { id: 'u1', ...user } as User;
    const save = jest.fn().mockImplementation((u: User) => Promise.resolve(u));
    const userRepository = {
      findOne: jest.fn().mockResolvedValue(stored),
      save,
    } as unknown as Repository<User>;
    const service = new UsersService(userRepository, {} as DataSource);
    return { service, stored, save };
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

  it('drops the plaintext when a ciphertext is saved - keeping it defeats the change', async () => {
    const { service, stored } = makeService({ notes: 'my bank pin' });
    await service.setNotes('u1', 'BBBB');
    expect(stored.notesCiphertext).toBe('BBBB');
    expect(stored.notes).toBeNull();
  });

  it('generates a 32-byte hex key once, then returns the same one', async () => {
    const { service, save } = makeService({});
    const key = await service.getOrCreateNotesKey('u1');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(save).toHaveBeenCalledTimes(1);

    // A second read must not rotate the key: every stored note would be lost.
    await expect(service.getOrCreateNotesKey('u1')).resolves.toBe(key);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
