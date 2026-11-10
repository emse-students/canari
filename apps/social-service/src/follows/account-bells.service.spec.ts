import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AccountBellsService,
  BELL_CODES,
  BELL_PUSH_KINDS,
  bellTargetOf,
  levelWithholds,
} from './account-bells.service';

/**
 * The bell's rules that need no database: which pushes a bell can reduce, which account a push
 * answers to, what each level withholds, and the refusals before any statement. The statements -
 * the upsert, the person's follow condition, the reset on a new follow, the migrations' copy and
 * mirror - are proven against PostgreSQL in `account-bells.integration.spec.ts`.
 */
describe('the bell rules', () => {
  it('reduces only the publication, live, birthday and friend-activity pushes, never a mention or a manager notice', () => {
    expect([...BELL_PUSH_KINDS.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['association_post', 'post'],
      ['association_repost', 'post'],
      ['birthday', 'post'],
      ['followed_post', 'post'],
      ['friend_comment', 'post'],
      ['friend_reaction', 'post'],
      ['live_started', 'live'],
      ['member_repost', 'post'],
      ['repost_personal_requested', 'post'],
    ]);
    for (const type of ['mention', 'reply', 'comment', 'reaction', 'repost_proposed']) {
      expect(bellTargetOf({ type, actorId: 'u1', associationId: 'a1' })).toBeNull();
    }
  });

  it('answers to the association when the push carries one, to the person acting otherwise', () => {
    expect(bellTargetOf({ type: 'live_started', actorId: 'member', associationId: 'a1' })).toEqual({
      kind: 'association',
      id: 'a1',
      push: 'live',
    });
    expect(bellTargetOf({ type: 'live_started', actorId: 'member' })).toEqual({
      kind: 'user',
      id: 'member',
      push: 'live',
    });
    expect(bellTargetOf({ type: 'followed_post', actorId: 'author' })).toEqual({
      kind: 'user',
      id: 'author',
      push: 'post',
    });
  });

  it('withholds everything at none, and only posts at lives', () => {
    expect(levelWithholds('none', 'post')).toBe(true);
    expect(levelWithholds('none', 'live')).toBe(true);
    expect(levelWithholds('lives', 'post')).toBe(true);
    expect(levelWithholds('lives', 'live')).toBe(false);
  });
});

describe('AccountBellsService refusals', () => {
  const repo = {
    query: jest.fn(),
    delete: jest.fn(),
    findOne: jest.fn(),
    manager: { transaction: jest.fn() },
  };
  const assoRepo = { exists: jest.fn() };
  const service = () => new AccountBellsService(repo as never, assoRepo as never);
  const codeOf = (e: unknown) => (e as { getResponse: () => { code: string } }).getResponse().code;

  beforeEach(() => {
    jest.clearAllMocks();
    repo.manager.transaction.mockImplementation((work: (em: unknown) => unknown) =>
      work({ query: repo.query })
    );
  });

  it('refuses an unknown kind or level before any statement', async () => {
    for (const [kind, level] of [
      ['page', 'none'],
      ['user', 'posts'],
    ] as const) {
      const e = await service()
        .setLevel('u1', kind as never, 't', level as never)
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(codeOf(e)).toBe(BELL_CODES.invalid);
    }
    expect(repo.query).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('refuses an association that does not exist, writing nothing', async () => {
    assoRepo.exists.mockResolvedValue(false);
    const e = await service()
      .setLevel('u1', 'association', 'nope', 'none')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotFoundException);
    expect(codeOf(e)).toBe(BELL_CODES.targetNotFound);
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('stores an association id lower-case, whatever the case it came in, and clears the legacy row', async () => {
    const id = '7A1C2D9E-0000-4000-8000-00000000000A';
    assoRepo.exists.mockResolvedValue(true);
    repo.query.mockResolvedValue([{ userId: 'u1' }]);
    await service().setLevel('u1', 'association', id, 'lives');
    expect(assoRepo.exists).toHaveBeenCalledWith({ where: { id: id.toLowerCase() } });
    const calls = repo.query.mock.calls as [string, string[]][];
    expect(calls[0][0]).toContain('DELETE FROM association_push_mutes');
    expect(calls[0][1]).toEqual(['u1', id.toLowerCase()]);
    expect(calls[1][1]).toEqual(['u1', 'association', id.toLowerCase(), 'lives']);
  });

  it('keeps the legacy row for none, and deletes it with the bell for all', async () => {
    const id = '7a1c2d9e-0000-4000-8000-00000000000a';
    assoRepo.exists.mockResolvedValue(true);
    repo.query.mockResolvedValue([{ userId: 'u1' }]);
    await service().setLevel('u1', 'association', id, 'none');
    expect(repo.query).toHaveBeenCalledTimes(1);
    repo.query.mockClear();
    await service().setLevel('u1', 'association', id.toUpperCase(), 'all');
    const sqls = (repo.query.mock.calls as [string, string[]][]).map(([sql]) => sql);
    expect(sqls[0]).toContain('DELETE FROM association_push_mutes');
    expect(sqls[1]).toContain('DELETE FROM account_bells');
  });

  it('refuses a person the caller does not follow: the conditional upsert wrote no row', async () => {
    repo.query.mockResolvedValue([]);
    const e = await service()
      .setLevel('u1', 'user', 'u2', 'lives')
      .catch((x: unknown) => x);
    expect(codeOf(e)).toBe(BELL_CODES.targetNotFound);
  });

  it('answers all when no row is stored', async () => {
    repo.findOne.mockResolvedValue(null);
    expect(await service().levelOf('u1', 'user', 'u2')).toBe('all');
  });
});
