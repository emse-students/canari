// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'viewer' }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { applyNicknameFrame } from './nicknameFrame';
import {
  nicknameEntry,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';

describe('applyNicknameFrame', () => {
  const log = vi.fn();
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
      0,
      log
    );
    expect(outcome).toBe('applied');
    expect(nicknameEntry('g1', 'bob')).toEqual({ nickname: 'Capitaine', setBy: 'ann', at: 10 });
  });

  it('applies a reset (null or empty once normalized)', () => {
    applyNicknameFrame('g1', { userId: 'bob', nickname: 'Capitaine', at: 10 }, 'ann', 0, log);
    expect(
      applyNicknameFrame('g1', { userId: 'bob', nickname: ' \u200b ', at: 11 }, 'bob', 0, log)
    ).toBe('applied');
    expect(nicknameEntry('g1', 'bob')?.nickname).toBeNull();
  });

  it('calls a replayed older frame stale', () => {
    applyNicknameFrame('g1', { userId: 'bob', nickname: 'B', at: 10 }, 'ann', 0, log);
    expect(applyNicknameFrame('g1', { userId: 'bob', nickname: 'A', at: 5 }, 'ann', 0, log)).toBe(
      'stale'
    );
  });

  it('dates a frame without `at` by the fallback', () => {
    applyNicknameFrame('g1', { userId: 'bob', nickname: 'B' }, 'ann', 77, log);
    expect(nicknameEntry('g1', 'bob')?.at).toBe(77);
  });

  it('refuses - and accuses - a frame naming nobody or over the limit', () => {
    expect(applyNicknameFrame('g1', { nickname: 'B', at: 1 }, 'ann', 0, log)).toBe('refused');
    expect(
      applyNicknameFrame('g1', { userId: 'bob', nickname: 'x'.repeat(101), at: 1 }, 'ann', 0, log)
    ).toBe('refused');
    expect(log.mock.calls.filter(([l]) => String(l).includes('REFUSED'))).toHaveLength(2);
    expect(nicknameEntry('g1', 'bob')).toBeNull();
  });
});
