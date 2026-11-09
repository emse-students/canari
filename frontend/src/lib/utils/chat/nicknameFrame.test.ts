// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'viewer' }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { applyNicknameFrame, nicknameMembersOf, type NicknameFrameContext } from './nicknameFrame';
import {
  MAX_NICKNAME_ENTRIES,
  applyNickname,
  nicknameEntries,
  nicknameEntry,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';

describe('applyNicknameFrame', () => {
  const log = vi.fn();
  const members = new Set(['ann', 'bob', 'viewer']);
  const ctx = (over: Partial<NicknameFrameContext> = {}): NicknameFrameContext => ({
    fallbackAt: 0,
    members,
    log,
    ...over,
  });
  beforeEach(() => {
    localStorage.clear();
    resetConversationNicknamesForTests();
    log.mockReset();
  });

  it('takes the setter from the MLS sender, never from the payload', () => {
    const outcome = applyNicknameFrame(
      'g1',
      { userId: 'Bob', nickname: 'Capitaine', at: 10, setBy: 'someone-else' } as never,
      'ann',
      ctx()
    );
    expect(outcome).toBe('applied');
    expect(nicknameEntry('g1', 'bob')).toEqual({
      nickname: 'Capitaine',
      setBy: 'ann',
      at: 10,
      verified: true,
    });
  });

  it('applies a reset (null or empty once normalized)', () => {
    applyNicknameFrame('g1', { userId: 'bob', nickname: 'Capitaine', at: 10 }, 'ann', ctx());
    expect(applyNicknameFrame('g1', { userId: 'bob', nickname: ' ​ ', at: 11 }, 'bob', ctx())).toBe(
      'applied'
    );
    expect(nicknameEntry('g1', 'bob')?.nickname).toBeNull();
  });

  it('calls a replayed older frame stale', () => {
    applyNicknameFrame('g1', { userId: 'bob', nickname: 'B', at: 10 }, 'ann', ctx());
    expect(applyNicknameFrame('g1', { userId: 'bob', nickname: 'A', at: 5 }, 'ann', ctx())).toBe(
      'stale'
    );
  });

  it('dates a frame without `at` by the fallback', () => {
    applyNicknameFrame('g1', { userId: 'bob', nickname: 'B' }, 'ann', ctx({ fallbackAt: 77 }));
    expect(nicknameEntry('g1', 'bob')?.at).toBe(77);
  });

  it('refuses - and accuses - a frame naming nobody or over the limit', () => {
    expect(applyNicknameFrame('g1', { nickname: 'B', at: 1 }, 'ann', ctx())).toBe('refused');
    expect(
      applyNicknameFrame('g1', { userId: 'bob', nickname: 'x'.repeat(101), at: 1 }, 'ann', ctx())
    ).toBe('refused');
    expect(log.mock.calls.filter(([l]) => String(l).includes('REFUSED'))).toHaveLength(2);
    expect(nicknameEntry('g1', 'bob')).toBeNull();
  });

  it('refuses a target who is no member, and everything when the roster is unreadable', () => {
    expect(
      applyNicknameFrame('g1', { userId: 'stranger', nickname: 'X', at: 1 }, 'ann', ctx())
    ).toBe('refused');
    expect(
      applyNicknameFrame(
        'g1',
        { userId: 'bob', nickname: 'X', at: 1 },
        'ann',
        ctx({ members: null })
      )
    ).toBe('refused');
    expect(nicknameEntries('g1')).toHaveLength(0);
  });

  it('takes a frame whose setter has left the tree since - live and replayed alike', () => {
    // Decrypting it proved the setter was in the tree at its epoch; the tree NOW is not asked.
    expect(applyNicknameFrame('g1', { userId: 'bob', nickname: 'X', at: 1 }, 'gone', ctx())).toBe(
      'applied'
    );
  });
});

describe('nicknameMembersOf', () => {
  it('reads the users of the tree, and fails closed when it cannot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await nicknameMembersOf(
      { getGroupMemberIdentities: async () => ['Ann:d1', 'bob:d2', 'bob:d3'] },
      'g1',
      'test'
    );
    expect([...(ok ?? [])].sort()).toEqual(['ann', 'bob']);
    expect(
      await nicknameMembersOf(
        {
          getGroupMemberIdentities: async () => {
            throw new Error('no group');
          },
        },
        'g1',
        'test'
      )
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the register has a hard cap, verified entries included', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConversationNicknamesForTests();
  });

  it('evicts a non-member first, then the oldest - never past the cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = Array.from({ length: MAX_NICKNAME_ENTRIES }, (_, i) => `u${i}`);
    for (const [i, id] of ids.entries()) {
      applyNickname('g1', id, { nickname: 'N', setBy: 'ann', at: 1000 + i });
    }
    // u0 is the oldest; u7 has left the conversation since.
    const members = new Set([...ids.filter((id) => id !== 'u7'), 'extra1', 'extra2']);
    applyNickname('g1', 'extra1', { nickname: 'N', setBy: 'ann', at: 5 }, members);
    expect(nicknameEntries('g1')).toHaveLength(MAX_NICKNAME_ENTRIES);
    expect(nicknameEntry('g1', 'u7')).toBeNull();
    expect(nicknameEntry('g1', 'u0')).not.toBeNull();
    applyNickname('g1', 'extra2', { nickname: 'N', setBy: 'ann', at: 6 }, members);
    expect(nicknameEntries('g1')).toHaveLength(MAX_NICKNAME_ENTRIES);
    // No non-member left: the oldest goes - here the entry dated 5.
    expect(nicknameEntry('g1', 'extra1')).toBeNull();
    warn.mockRestore();
  });
});
